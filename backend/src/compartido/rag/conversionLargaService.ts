import { contarPaginas, partirEnBloques } from '../services/pdfPaginasService';
import {
  convertirAMarkdownActivo,
  type ResultadoConversionConMetodo,
} from './conversionProviderService';
import type { AvanceFase, ReportarFase } from './fasesConversion';
import { ConversionError } from './mdConvertService';

/**
 * Troceo de documentos largos: parte un PDF en bloques de pocas páginas y convierte cada uno por
 * separado a través del pipeline de siempre (`convertirAMarkdownActivo` — markitdown, con
 * respaldo en mineru). El DOCUMENTO deja de tener límite de tiempo porque cada LLAMADA sigue
 * acotada a los mismos 180/300 s de siempre: el cortacircuitos, el `AbortController` y el límite
 * duro de `mdConvertService`/`mineruConvertService` no se tocan ni se rodean.
 *
 * Ver la sección 1-2 de `docs/PLAN-RAG-IMPLEMENTACION.md` §8 (bug #7: un solo documento congeló
 * una cola de 500 durante 45 min) — la razón de NO simplemente subir los timeouts es esa.
 */

const PAGINAS_POR_BLOQUE = Number(process.env.RAG_PAGINAS_POR_BLOQUE ?? 15);

function partirNombre(filename: string): { nombre: string; extension: string } {
  const punto = filename.lastIndexOf('.');
  if (punto <= 0) return { nombre: filename, extension: '' };
  return { nombre: filename.slice(0, punto), extension: filename.slice(punto) };
}

function pad(pagina: number): string {
  return String(pagina).padStart(4, '0');
}

/**
 * Convierte un PDF largo bloque a bloque y concatena el resultado.
 *
 * Un bloque que falla NO tumba el documento entero: se sustituye por un marcador explícito
 * (`[No se pudo extraer el texto de las páginas X–Y: motivo]`) y el troceo continúa con el
 * siguiente. Solo si fallan TODOS los bloques se considera que la conversión fracasó — un
 * conversor caído no puede producir un documento "convertido" que son puros marcadores.
 *
 * `onLatido`, si se pasa, se llama al terminar CADA bloque — es lo que permite a `ingestaService`
 * renovar el `lease_hasta` del ítem entre bloques: sin esto, un documento de 40 min vencería el
 * lease de 10 min y `reanudarJobsInterrumpidos()` lo reclamaría al arrancar estando perfectamente
 * vivo.
 */
export async function convertirPorBloques(
  buffer: Buffer,
  filename: string,
  onFase?: ReportarFase,
  onLatido?: () => Promise<void>,
): Promise<ResultadoConversionConMetodo> {
  const totalPaginas = await contarPaginas(buffer);
  if (totalPaginas === null) {
    // No debería pasar (el llamador ya contó páginas para decidir trocear), pero si el PDF deja
    // de cargar entre medias, es un fallo transitorio de lectura, no del archivo en sí.
    throw new ConversionError('No se pudo leer el PDF para trocearlo en bloques', true);
  }
  const totalBloques = Math.ceil(totalPaginas / PAGINAS_POR_BLOQUE);
  const { nombre, extension } = partirNombre(filename);

  const partes: string[] = [];
  const metodosPorBloque = new Map<string, number>();
  const rangosFallidos: string[] = [];
  let msTotal = 0;
  let bloquesOk = 0;
  let numeroBloque = 0;

  for await (const bloque of partirEnBloques(buffer, PAGINAS_POR_BLOQUE)) {
    numeroBloque++;
    // markitdown detecta el tipo de archivo por la EXTENSIÓN del nombre, no por el contenido —
    // el nombre del bloque debe conservar la extensión real del documento.
    const nombreBloque = `${nombre}.p${pad(bloque.desde)}-${pad(bloque.hasta)}${extension}`;

    const reportarBloque: ReportarFase | undefined = onFase
      && ((avance: AvanceFase) => onFase({
        ...avance,
        bloque: numeroBloque,
        bloques: totalBloques,
        paginaDesde: bloque.desde,
        paginaHasta: bloque.hasta,
      }));

    try {
      const resultado = await convertirAMarkdownActivo(bloque.buffer, nombreBloque, reportarBloque);
      partes.push(resultado.markdown);
      metodosPorBloque.set(resultado.metodo, (metodosPorBloque.get(resultado.metodo) ?? 0) + 1);
      msTotal += resultado.ms;
      bloquesOk++;
    } catch (error) {
      const motivo = error instanceof Error ? error.message : 'error desconocido';
      partes.push(`> [No se pudo extraer el texto de las páginas ${bloque.desde}–${bloque.hasta}: ${motivo}]`);
      rangosFallidos.push(`${bloque.desde}-${bloque.hasta}`);
    }

    if (onLatido) await onLatido();
  }

  if (bloquesOk === 0) {
    throw new ConversionError(
      `Ningún bloque pudo convertirse de ${totalBloques} (páginas: ${rangosFallidos.join(', ')})`,
      true,
    );
  }

  // El proveedor "ganador" es el que resolvió más bloques — casi siempre el activo, salvo que su
  // circuito se haya abierto a mitad de camino y el resto haya salido por el respaldo.
  const metodoGanador = [...metodosPorBloque.entries()].sort((a, b) => b[1] - a[1])[0][0];

  return {
    markdown: partes.join('\n\n'),
    ms: msTotal,
    metodo: `${metodoGanador}-bloques`,
    advertencia: rangosFallidos.length > 0
      ? `${rangosFallidos.length} de ${totalBloques} bloques no se pudieron convertir (páginas: ${rangosFallidos.join(', ')})`
      : undefined,
  };
}
