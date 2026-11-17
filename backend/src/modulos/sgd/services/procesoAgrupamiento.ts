import { createHash } from 'node:crypto';

/**
 * Agrupamiento automático de expedientes en familias de proceso, a partir del asunto de ORIGEN.
 *
 * Vive aparte de `dashboardResumenService.ts` (que lo usa en el refresco) y de
 * `calidadProcesosService.ts` (que lo usa al consultar) porque ambos lo necesitan y así no hay
 * ciclo de imports entre servicios. `normalizarAsunto` se movió aquí desde
 * `dashboardResumenService.ts` por el mismo motivo — su comportamiento no cambió (ver migración
 * 012, que todavía la nombra por su ubicación anterior).
 *
 * Todo es función pura y sin BD: se puede probar sin levantar nada.
 */

/**
 * Normaliza un asunto para compararlo por igualdad exacta: mayúsculas, sin tildes, espacios
 * colapsados y sin puntuación de borde. Sin esto, el mismo asunto escrito dos veces a mano
 * ("Solicito informe técnico" / "SOLICITO INFORME TECNICO.") contaría como dos asuntos distintos y
 * suprimiría un reproceso real.
 *
 * Se hace en TypeScript, no en SQL, porque la consulta de origen corre contra el SGD: así el
 * criterio queda en un único sitio testeable y no depende de que `unaccent` exista en esa base.
 *
 * Devuelve `null` si no queda nada: un documento sin asunto no puede marcar reproceso (ver el
 * guard `asunto_norm IS NOT NULL` en `dashboardService.ts`).
 */
export function normalizarAsunto(crudo: string | null): string | null {
  if (!crudo) return null;

  const normalizado = crudo
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // acentos combinados que deja el NFD
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s.,;:¡!¿?"'()\-–—_*]+|[\s.,;:¡!¿?"'()\-–—_*]+$/g, '')
    .toUpperCase();

  return normalizado === '' ? null : normalizado;
}

/** Un asunto tiene que traer al menos esto de texto útil tras quitarle códigos y números para que
 *  valga la pena compararlo — por debajo queda "DE LA" y cosas así, que se parecen a todo. */
const LARGO_MINIMO_ESQUELETO = 4;

/**
 * "Esqueleto" de un asunto: lo que queda cuando se le quita todo lo que lo hace único sin describir
 * el trámite — números de documento, fechas y códigos (`N° 169-2026-PMESUT`, `SCCP 170-2026`).
 *
 * Es una transformación DISTINTA de `normalizarAsunto`, con un propósito opuesto y por eso no la
 * reemplaza: aquélla conserva los números porque ahí son justamente lo que distingue un asunto de
 * otro dentro de un mismo expediente (Reproceso); ésta los borra porque son lo que impide ver que
 * "…PAGO DE CONSULTORÍA SCCP 169-2026" y "…PAGO DE CONSULTORÍA SCCP 170-2026" son el MISMO proceso.
 *
 * Verificado ✅ 2026-09-02 contra la BD real: sin este paso, 3 919 de 4 618 expedientes (85%) tienen
 * un asunto de origen literalmente único y no se agruparía nada.
 *
 * Devuelve `null` si no queda texto suficiente: ese expediente queda sin familia, no en una familia
 * basura junto a todos los demás asuntos vacíos.
 */
export function esqueletoAsunto(crudo: string | null): string | null {
  const base = normalizarAsunto(crudo);
  if (!base) return null;

  const esqueleto = base
    .replace(/\bN[°º]?\s*\d[\w\-/.]*/g, ' ') // "N° 169-2026-PMESUT"
    .replace(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, ' ') // fechas
    .replace(/\b[\w.]*\d[\w.\-/]*\b/g, ' ') // cualquier token que contenga un dígito
    .replace(/[^A-ZÑ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return esqueleto.length < LARGO_MINIMO_ESQUELETO ? null : esqueleto;
}

/** Trigramas del texto, con relleno en los bordes para que el inicio y el final pesen igual que el
 *  medio (misma convención que `pg_trgm`, cuyo comportamiento imitamos sin instalar la extensión). */
function trigramas(texto: string): Set<string> {
  const relleno = `  ${texto} `;
  const set = new Set<string>();
  for (let i = 0; i < relleno.length - 2; i += 1) set.add(relleno.slice(i, i + 3));
  return set;
}

/** Coeficiente de Dice entre dos conjuntos de trigramas: 1 = idénticos, 0 = nada en común. */
function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let comunes = 0;
  for (const g of a) if (b.has(g)) comunes += 1;
  return (2 * comunes) / (a.size + b.size);
}

/** Solo para tests y calibración: la similitud entre dos asuntos ya esqueletizados. */
export function similitudAsuntos(a: string, b: string): number {
  return dice(trigramas(a), trigramas(b));
}

export interface EntradaAsunto {
  esqueleto: string;
  /** Cuántos expedientes traen este mismo esqueleto — decide quién puede ser líder de familia. */
  frecuencia: number;
}

export interface FamiliaProceso {
  /** Hash del esqueleto líder. Estable entre refrescos, a diferencia de un id secuencial — es lo
   *  que permite que `dashboard.proceso_alias` (el renombre manual) siga apuntando a la misma
   *  familia después de reagrupar desde cero. */
  clave: string;
  /** El esqueleto del líder, que se usa como nombre automático de la familia. */
  nombre: string;
  expedientes: number;
}

export function claveDeProceso(esqueletoLider: string): string {
  return createHash('sha1').update(esqueletoLider).digest('hex').slice(0, 16);
}

/**
 * Agrupa esqueletos de asunto en familias por similitud de trigramas, con un **líder codicioso**:
 * se recorren los esqueletos de más a menos frecuente y cada uno se une al líder más parecido que
 * supere `umbral`, o funda una familia nueva si ninguno lo supera.
 *
 * **Determinista**: el orden de recorrido es (frecuencia desc, texto asc), así que el mismo conjunto
 * de entrada produce siempre las mismas familias, sin importar en qué orden lo devolvió la BD. Sin
 * esto, el nombre de una familia podría cambiar entre refrescos y los alias manuales quedarían
 * apuntando a otra cosa.
 *
 * **Por qué no `pg_trgm`**: la extensión resolvería la similitud, pero no el agrupamiento (el líder
 * codicioso es secuencial y no se expresa bien en SQL), obligaría a instalar una extensión y movería
 * el criterio fuera del código donde se puede probar. La decisión es la misma que ya se tomó para
 * `normalizarAsunto` en su momento.
 *
 * **Coste**: sin ningún filtro sería O(n²). Se acota con un índice invertido de token → líderes:
 * solo se comparan líderes que comparten al menos una palabra con el candidato. Medido ✅
 * 2026-09-02: 1,2 s para 1 501 esqueletos (expedientes cerrados) y 7,5 s para 3 399 (todos).
 *
 * @param umbral Similitud mínima (0-1) para caer en la misma familia. Calibrado en 0,55 contra la
 *   BD real: 0,45 mezcla trámites distintos y 0,65 fragmenta de más (ver migración 013).
 * @returns esqueleto → familia a la que quedó asignado.
 */
export function agruparAsuntos(
  entradas: EntradaAsunto[],
  umbral: number,
): Map<string, FamiliaProceso> {
  const orden = [...entradas].sort(
    (a, b) => b.frecuencia - a.frecuencia || (a.esqueleto < b.esqueleto ? -1 : 1),
  );

  interface Lider {
    esqueleto: string;
    trigramas: Set<string>;
    expedientes: number;
  }
  const lideres: Lider[] = [];
  const porToken = new Map<string, number[]>(); // token → índices de líder que lo contienen
  const asignacion = new Map<string, number>(); // esqueleto → índice de su líder

  for (const entrada of orden) {
    const tokens = entrada.esqueleto.split(' ');
    const tri = trigramas(entrada.esqueleto);

    const candidatos = new Set<number>();
    for (const token of tokens) {
      for (const i of porToken.get(token) ?? []) candidatos.add(i);
    }

    let mejor = -1;
    let mejorSimilitud = 0;
    for (const i of candidatos) {
      const similitud = dice(tri, lideres[i].trigramas);
      if (similitud >= umbral && similitud > mejorSimilitud) {
        mejorSimilitud = similitud;
        mejor = i;
      }
    }

    if (mejor >= 0) {
      lideres[mejor].expedientes += entrada.frecuencia;
      asignacion.set(entrada.esqueleto, mejor);
      continue;
    }

    const indice = lideres.length;
    lideres.push({ esqueleto: entrada.esqueleto, trigramas: tri, expedientes: entrada.frecuencia });
    asignacion.set(entrada.esqueleto, indice);
    for (const token of new Set(tokens)) {
      const lista = porToken.get(token);
      if (lista) lista.push(indice);
      else porToken.set(token, [indice]);
    }
  }

  const familias = new Map<string, FamiliaProceso>();
  for (const [esqueleto, indice] of asignacion) {
    const lider = lideres[indice];
    familias.set(esqueleto, {
      clave: claveDeProceso(lider.esqueleto),
      nombre: lider.esqueleto,
      expedientes: lider.expedientes,
    });
  }
  return familias;
}
