/**
 * Troceado del Markdown, consciente de su estructura.
 *
 * 700 tokens con 120 de solape. El tamaño no es arbitrario: los actos administrativos peruanos
 * razonan por bloques (VISTOS / CONSIDERANDO / SE RESUELVE) y 700 tokens es aproximadamente un
 * "considerando" completo o dos o tres artículos de una resolución. Partir por debajo separa la
 * premisa de su conclusión, y entonces el chunk recuperado no responde la pregunta.
 *
 * El español gasta un 15-20 % más de tokens que el inglés con BPE, así que 700 tokens es menos
 * texto del que parece.
 */

const TOKENS_OBJETIVO = Number(process.env.RAG_CHUNK_TOKENS ?? 700);
const TOKENS_SOLAPE = Number(process.env.RAG_CHUNK_SOLAPE ?? 120);
/** Aproximación: ~3,5 caracteres por token en español. */
const CHARS_POR_TOKEN = 3.5;

const CHARS_OBJETIVO = Math.round(TOKENS_OBJETIVO * CHARS_POR_TOKEN);
const CHARS_SOLAPE = Math.round(TOKENS_SOLAPE * CHARS_POR_TOKEN);

export interface Chunk {
  ord: number;
  texto: string;
  rutaTitulos: string;
  carInicio: number;
  carFin: number;
  tokens: number;
}

export function estimarTokens(texto: string): number {
  return Math.ceil(texto.length / CHARS_POR_TOKEN);
}

interface Bloque {
  texto: string;
  inicio: number;
  ruta: string;
  esTabla: boolean;
}

/**
 * Divide el Markdown en bloques respetando encabezados y tablas, y luego los agrupa hasta
 * `CHARS_OBJETIVO`. Nunca parte dentro de una tabla: si una tabla no cabe, se corta por filas
 * repitiendo su cabecera, para que cada trozo siga siendo legible por sí solo.
 */
export function trocear(markdown: string): Chunk[] {
  const bloques = separarEnBloques(markdown);
  const chunks: Chunk[] = [];

  let acumulado: Bloque[] = [];
  let longitud = 0;

  const cerrar = () => {
    if (acumulado.length === 0) return;
    const texto = acumulado.map((b) => b.texto).join('\n\n').trim();
    if (texto.length === 0) {
      acumulado = [];
      longitud = 0;
      return;
    }

    const inicio = acumulado[0].inicio;
    chunks.push({
      ord: chunks.length,
      texto,
      // La ruta del ÚLTIMO bloque, no del primero: un encabezado aplica a todo lo que le sigue
      // hasta el próximo, así que si VISTOS y CONSIDERANDO caen en el mismo chunk, la mayoría del
      // texto vive bajo CONSIDERANDO. Usar el primero citaría la sección equivocada al embeber.
      rutaTitulos: acumulado[acumulado.length - 1].ruta,
      carInicio: inicio,
      carFin: inicio + texto.length,
      tokens: estimarTokens(texto),
    });

    // Solape: se arrastran los últimos bloques hasta cubrir CHARS_SOLAPE, para que una idea a
    // caballo entre dos chunks aparezca entera al menos en uno.
    const arrastre: Bloque[] = [];
    let acumuladoSolape = 0;
    for (let i = acumulado.length - 1; i >= 0 && acumuladoSolape < CHARS_SOLAPE; i--) {
      if (acumulado[i].esTabla) break; // no arrastrar tablas: duplicarlas no aporta
      arrastre.unshift(acumulado[i]);
      acumuladoSolape += acumulado[i].texto.length;
    }

    // Si el arrastre es todo lo que había, no hay solape posible sin repetir el chunk entero.
    acumulado = arrastre.length < acumulado.length ? arrastre : [];
    longitud = acumulado.reduce((n, b) => n + b.texto.length, 0);
  };

  for (const bloque of bloques) {
    if (bloque.texto.length > CHARS_OBJETIVO) {
      cerrar();
      for (const trozo of partirBloqueGrande(bloque)) {
        chunks.push({ ...trozo, ord: chunks.length });
      }
      continue;
    }

    if (longitud + bloque.texto.length > CHARS_OBJETIVO) cerrar();

    acumulado.push(bloque);
    longitud += bloque.texto.length;
  }

  cerrar();
  return chunks;
}

function separarEnBloques(markdown: string): Bloque[] {
  const lineas = markdown.split('\n');
  const bloques: Bloque[] = [];
  const pila: string[] = [];

  let buffer: string[] = [];
  let inicioBuffer = 0;
  let posicion = 0;
  let enTabla = false;

  const volcar = () => {
    const texto = buffer.join('\n').trim();
    if (texto) {
      bloques.push({ texto, inicio: inicioBuffer, ruta: pila.filter(Boolean).join(' > '), esTabla: enTabla });
    }
    buffer = [];
    enTabla = false;
  };

  for (const linea of lineas) {
    const encabezado = /^(#{1,6})\s+(.*)$/.exec(linea);
    const esFilaTabla = /^\s*\|.*\|\s*$/.test(linea);

    if (encabezado) {
      volcar();
      const nivel = encabezado[1].length;
      pila.length = nivel - 1;
      pila[nivel - 1] = encabezado[2].trim();
      inicioBuffer = posicion;
      buffer.push(linea);
    } else if (esFilaTabla) {
      if (!enTabla) {
        volcar();
        inicioBuffer = posicion;
        enTabla = true;
      }
      buffer.push(linea);
    } else if (linea.trim() === '') {
      if (enTabla) volcar();
      else if (buffer.length > 0) volcar();
      inicioBuffer = posicion + linea.length + 1;
    } else {
      if (enTabla) {
        volcar();
        inicioBuffer = posicion;
      }
      if (buffer.length === 0) inicioBuffer = posicion;
      buffer.push(linea);
    }

    posicion += linea.length + 1;
  }

  volcar();
  return bloques;
}

/** Un bloque más grande que el objetivo: tabla por filas, texto por frases. */
function partirBloqueGrande(bloque: Bloque): Omit<Chunk, 'ord'>[] {
  if (bloque.esTabla) return partirTabla(bloque);

  const frases = bloque.texto.split(/(?<=[.;:])\s+/);
  const trozos: Omit<Chunk, 'ord'>[] = [];
  let actual = '';

  for (const frase of frases) {
    if (actual.length + frase.length > CHARS_OBJETIVO && actual) {
      trozos.push(crear(actual, bloque));
      actual = '';
    }
    // Una sola "frase" gigantesca (texto sin puntuación, típico de un OCR malo) se corta a lo bruto.
    if (frase.length > CHARS_OBJETIVO) {
      for (let i = 0; i < frase.length; i += CHARS_OBJETIVO) {
        trozos.push(crear(frase.slice(i, i + CHARS_OBJETIVO), bloque));
      }
      continue;
    }
    actual += (actual ? ' ' : '') + frase;
  }

  if (actual.trim()) trozos.push(crear(actual, bloque));
  return trozos;
}

/**
 * Parte una tabla por filas repitiendo la cabecera en cada trozo. Sin la cabecera, un trozo de
 * tabla es una retahíla de cifras sin decir de qué son.
 */
function partirTabla(bloque: Bloque): Omit<Chunk, 'ord'>[] {
  const filas = bloque.texto.split('\n');
  const cabecera = filas.slice(0, 2).join('\n'); // encabezado + separador
  const cuerpo = filas.slice(2);

  const trozos: Omit<Chunk, 'ord'>[] = [];
  let actual: string[] = [];
  let longitud = cabecera.length;

  for (const fila of cuerpo) {
    if (longitud + fila.length > CHARS_OBJETIVO && actual.length > 0) {
      trozos.push(crear([cabecera, ...actual].join('\n'), bloque));
      actual = [];
      longitud = cabecera.length;
    }
    actual.push(fila);
    longitud += fila.length + 1;
  }

  if (actual.length > 0) trozos.push(crear([cabecera, ...actual].join('\n'), bloque));
  return trozos.length > 0 ? trozos : [crear(bloque.texto, bloque)];
}

function crear(texto: string, bloque: Bloque): Omit<Chunk, 'ord'> {
  const limpio = texto.trim();
  return {
    texto: limpio,
    rutaTitulos: bloque.ruta,
    carInicio: bloque.inicio,
    carFin: bloque.inicio + limpio.length,
    tokens: estimarTokens(limpio),
  };
}

/**
 * Cabecera de contexto que se antepone al texto **solo para embeber** (lo que se cita es el texto
 * a secas). Es la mejora de recall más barata que existe: sin ella, un chunk que dice "se aprueba
 * lo solicitado" no lo recupera ninguna consulta, porque no menciona ni el expediente, ni el tipo
 * de documento, ni la dependencia.
 */
export function construirCabecera(datos: {
  titulo?: string | null;
  numeroExpediente?: string | null;
  dependencia?: string | null;
  fecha?: string | null;
  asunto?: string | null;
  rutaTitulos?: string | null;
}): string {
  const partes = [
    datos.titulo,
    datos.numeroExpediente ? `Expediente ${datos.numeroExpediente}` : null,
    datos.dependencia,
    datos.fecha,
    datos.asunto,
    datos.rutaTitulos,
  ].filter(Boolean);

  return partes.join(' · ');
}
