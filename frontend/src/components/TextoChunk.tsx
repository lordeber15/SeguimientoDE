import { Fragment, type ReactNode } from 'react';

/**
 * Renderizador mínimo del markdown que producen los chunks del SGD (`chunkService`): encabezados,
 * listas, negritas y párrafos. Nada más — no es un motor de markdown de propósito general.
 *
 * Construye elementos de React, nunca HTML como cadena: no hay `dangerouslySetInnerHTML` en ningún
 * punto, así que el texto del documento no puede inyectar marcado por mucho que lo intente. Es la
 * razón de escribirlo a mano en vez de traer una dependencia — el corpus viene de PDFs convertidos,
 * que es contenido en el que no conviene confiar.
 *
 * Antes esto se pintaba como texto plano heredando `white-space: pre-wrap`, de ahí que los `#` y
 * los saltos del markdown salieran literales en pantalla.
 */

type Bloque =
  | { tipo: 'titulo'; nivel: 1 | 2; texto: string }
  | { tipo: 'lista'; ordenada: boolean; items: string[] }
  | { tipo: 'parrafo'; lineas: string[] };

const RE_TITULO = /^(#{1,6})\s+(.*)$/;
const RE_VINETA = /^\s*[-*•]\s+(.*)$/;
const RE_NUMERADA = /^\s*\d+[.)]\s+(.*)$/;

/** Agrupa las líneas en bloques. Una línea en blanco cierra el bloque en curso. */
function aBloques(texto: string): Bloque[] {
  const bloques: Bloque[] = [];
  let actual: Bloque | null = null;

  const cerrar = () => {
    if (actual) bloques.push(actual);
    actual = null;
  };

  for (const linea of texto.split('\n')) {
    if (!linea.trim()) {
      cerrar();
      continue;
    }

    const titulo = RE_TITULO.exec(linea);
    if (titulo) {
      cerrar();
      // Todo lo que pase de `##` se pinta igual: dentro de un fragmento suelto, más de dos niveles
      // de jerarquía visual no aporta nada y solo genera texto diminuto.
      bloques.push({ tipo: 'titulo', nivel: titulo[1].length === 1 ? 1 : 2, texto: titulo[2].trim() });
      continue;
    }

    const vineta = RE_VINETA.exec(linea);
    const numerada = vineta ? null : RE_NUMERADA.exec(linea);
    if (vineta || numerada) {
      const ordenada = numerada !== null;
      if (actual?.tipo !== 'lista' || actual.ordenada !== ordenada) {
        cerrar();
        actual = { tipo: 'lista', ordenada, items: [] };
      }
      actual.items.push((vineta ?? numerada)![1].trim());
      continue;
    }

    if (actual?.tipo !== 'parrafo') {
      cerrar();
      actual = { tipo: 'parrafo', lineas: [] };
    }
    actual.lineas.push(linea.trim());
  }

  cerrar();
  return bloques;
}

// El grupo va capturado para que `split` conserve los delimitadores y los índices impares sean
// siempre el contenido en negrita.
const RE_NEGRITA = /\*\*(.+?)\*\*/g;

/** `**negrita**` → `<strong>`. El resto del texto se emite tal cual, como nodo de texto. */
function conNegritas(texto: string): ReactNode {
  const partes = texto.split(RE_NEGRITA);
  if (partes.length === 1) return texto;
  return partes.map((parte, i) =>
    i % 2 === 1 ? <strong key={i}>{parte}</strong> : <Fragment key={i}>{parte}</Fragment>,
  );
}

export function TextoChunk({ texto }: { texto: string }) {
  return (
    <div className="chunk-md">
      {aBloques(texto).map((bloque, i) => {
        if (bloque.tipo === 'titulo') {
          return bloque.nivel === 1
            ? <h4 key={i} className="chunk-md-h1">{conNegritas(bloque.texto)}</h4>
            : <h5 key={i} className="chunk-md-h2">{conNegritas(bloque.texto)}</h5>;
        }

        if (bloque.tipo === 'lista') {
          const items = bloque.items.map((item, j) => <li key={j}>{conNegritas(item)}</li>);
          return bloque.ordenada
            ? <ol key={i} className="chunk-md-lista">{items}</ol>
            : <ul key={i} className="chunk-md-lista">{items}</ul>;
        }

        // Las líneas de un mismo párrafo se unen con espacio: en el markdown convertido desde PDF
        // los saltos son artefactos del ancho de página, no separaciones queridas.
        return <p key={i}>{conNegritas(bloque.lineas.join(' '))}</p>;
      })}
    </div>
  );
}
