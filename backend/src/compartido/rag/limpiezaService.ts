/**
 * Limpieza del Markdown que devuelve markitdown, antes de trocear.
 *
 * El orden importa: los data URI se eliminan **primero**. Un `data:image/png;base64,...` de 3 MB
 * es una sola "palabra" de tres millones de caracteres, y cualquier expresión regular posterior
 * que la recorra con retroceso tarda minutos o se cuelga.
 */

/** Menos texto que esto tras limpiar significa que el PDF era una imagen sin OCR aprovechable. */
const MINIMO_CARACTERES = Number(process.env.RAG_MIN_CARACTERES ?? 200);

export interface ResultadoLimpieza {
  markdown: string;
  chars: number;
  /** Sin texto útil: el documento se marca `sin_texto` y no se trocea ni se embebe. */
  sinTexto: boolean;
  dataUrisEliminados: number;
  lineasRepetidasEliminadas: number;
}

export function limpiarMarkdown(bruto: string): ResultadoLimpieza {
  let texto = bruto ?? '';

  // 1. Data URIs. Se cuentan porque son un indicador de PDF escaneado.
  const antesDataUri = texto.length;
  let dataUrisEliminados = 0;
  texto = texto.replace(/!\[[^\]]*\]\(\s*data:[^)]*\)/g, () => {
    dataUrisEliminados++;
    return '';
  });
  texto = texto.replace(/data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{100,}/gi, () => {
    dataUrisEliminados++;
    return '';
  });
  if (texto.length !== antesDataUri) texto = texto.replace(/\n{3,}/g, '\n\n');

  // 2. Palabras partidas por guion al final de línea: "adminis-\ntración" → "administración".
  //    Sin esto, el término queda partido en dos y ni la búsqueda por texto ni el embedding lo
  //    reconocen. Solo se une si la línea siguiente empieza en minúscula, para no destrozar
  //    guiones legítimos ni las viñetas de una lista.
  // Sin la flag "i": el propio comentario exige minúscula tras el salto, y "gi" la anulaba,
  // fusionando también "Lima-\nCallao" como si fuera una palabra partida.
  texto = texto.replace(/([a-záéíóúñA-ZÁÉÍÓÚÑ])-\n(?=[a-záéíóúñ])/g, '$1');

  // 3. Cabeceras y pies repetidos en la mayoría de páginas.
  const { limpio, eliminadas } = quitarLineasRepetidas(texto);
  texto = limpio;

  texto = texto.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();

  return {
    markdown: texto,
    chars: texto.length,
    sinTexto: texto.length < MINIMO_CARACTERES,
    dataUrisEliminados,
    lineasRepetidasEliminadas: eliminadas,
  };
}

/**
 * Elimina las líneas que se repiten en ≥60 % de las páginas: membretes, pies institucionales y
 * numeraciones. Bajan ~10 % los tokens y, sobre todo, ensucian el retrieval — un membrete
 * repetido 200 veces compite con el contenido real en cada búsqueda.
 *
 * Se exige un mínimo de páginas para no vaciar un documento corto donde cualquier repetición es
 * casual.
 */
function quitarLineasRepetidas(texto: string): { limpio: string; eliminadas: number } {
  const paginas = texto.split(/\n?-{3,}\n|\f/);
  if (paginas.length < 4) return { limpio: texto, eliminadas: 0 };

  const apariciones = new Map<string, number>();
  for (const pagina of paginas) {
    const unicas = new Set(
      pagina
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 3 && l.length < 120),
    );
    for (const linea of unicas) apariciones.set(linea, (apariciones.get(linea) ?? 0) + 1);
  }

  const umbral = Math.ceil(paginas.length * 0.6);
  const repetidas = new Set(
    [...apariciones.entries()].filter(([, n]) => n >= umbral).map(([l]) => l),
  );

  if (repetidas.size === 0) return { limpio: texto, eliminadas: 0 };

  let eliminadas = 0;
  const limpio = texto
    .split('\n')
    .filter((linea) => {
      if (repetidas.has(linea.trim())) {
        eliminadas++;
        return false;
      }
      return true;
    })
    .join('\n');

  return { limpio, eliminadas };
}
