import { trazaActual } from './traza';

/**
 * Alertas en tiempo real hacia un webhook (docs/PLAN-RAG-AVANZADO.md, Fase 2). El chat degrada con
 * seguridad a propósito — sin embeddings cae a FTS, sin planificador cae al plan de respaldo —, y eso
 * es bueno para el usuario pero invisible para quien opera: el 2026-10-06 Ollama estuvo apagado y la
 * rama vectorial devolvió 0 en todas las consultas sin que nadie se enterara. Estas alertas son la
 * contraparte de esa degradación silenciosa.
 *
 * `ALERTA_WEBHOOK_URL` sin definir = alertas apagadas (solo quedan en el log). El cuerpo lleva `text`
 * (Slack, Teams, Mattermost, Google Chat) y `content` (Discord) además de los campos estructurados, así
 * que sirve con la mayoría de webhooks entrantes sin adaptador.
 *
 * Nunca lanza ni se espera: una alerta que falla no puede tumbar lo que la disparó.
 */

export type TipoAlerta =
  | 'proveedor_ia'          // un proveedor de IA falló tras agotar los reintentos (o credencial inválida)
  | 'planificador_json'     // el planificador devolvió algo que no es un plan: se usó el de respaldo
  | 'vectorial_degradada'   // sin embedding de la consulta: el retrieval cayó a FTS puro
  | 'rerank_degradado'      // el cross-encoder no respondió: se usó el orden de RRF
  | 'marcadores_alucinados' // el modelo citó [Dn] que no se le ofrecieron
  | 'chat_error';           // error no controlado en el chat (HTTP 500)

/** Una alerta del mismo tipo (y clave) como máximo cada este intervalo; las demás se cuentan. */
const intervaloMs = () => Math.max(0, Number(process.env.ALERTA_INTERVALO_MIN ?? 10)) * 60_000;

const ultimoEnvio = new Map<string, number>();
const suprimidas = new Map<string, number>();

export function alertar(
  tipo: TipoAlerta,
  mensaje: string,
  detalle: Record<string, unknown> = {},
  /** Distingue alertas del mismo tipo que no deben silenciarse entre sí (p. ej. por proveedor). */
  clave = '',
): void {
  const id = `${tipo}|${clave}`;
  const ahora = Date.now();
  const previo = ultimoEnvio.get(id);
  if (previo !== undefined && ahora - previo < intervaloMs()) {
    suprimidas.set(id, (suprimidas.get(id) ?? 0) + 1);
    return;
  }
  ultimoEnvio.set(id, ahora);
  const omitidas = suprimidas.get(id) ?? 0;
  suprimidas.delete(id);

  const traza = trazaActual();
  const linea = `[seguimiento] ${tipo}: ${mensaje}${omitidas > 0 ? ` (+${omitidas} similares omitidas)` : ''}`;
  console.warn(`ALERTA ${linea}`);

  const url = process.env.ALERTA_WEBHOOK_URL?.trim();
  if (!url) return;

  const cuerpo = {
    text: linea,
    content: linea.slice(0, 2000),
    tipo,
    mensaje,
    detalle,
    omitidas,
    trazaId: traza?.id ?? null,
    modulo: traza?.modulo ?? null,
    usuarioId: traza?.usuarioId ?? null,
    fe: new Date(ahora).toISOString(),
  };
  void enviar(url, cuerpo);
}

async function enviar(url: string, cuerpo: unknown): Promise<void> {
  const abortador = new AbortController();
  const temporizador = setTimeout(() => abortador.abort(), 5000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo),
      signal: abortador.signal,
    });
    if (!r.ok) console.warn(`El webhook de alertas respondió HTTP ${r.status}`);
  } catch (e) {
    console.warn(`No se pudo enviar la alerta al webhook: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(temporizador);
  }
}

/** El modelo citó `[Dn]` que no se le ofrecieron (ya se quitaron del texto). Común a SGD y STD. */
export function avisarMarcadoresAlucinados(
  modulo: 'sgd' | 'std',
  invalidos: number[],
  proveedor: { nombre: string; modelo: string },
): void {
  if (invalidos.length === 0) return;
  alertar('marcadores_alucinados', `${modulo.toUpperCase()}: el modelo citó ${invalidos.length} fragmento(s) que no se le ofrecieron`, {
    marcadores: invalidos.slice(0, 10), proveedor: proveedor.nombre, modelo: proveedor.modelo,
  }, modulo);
}

/** Solo para tests: olvida el historial de envíos (el límite por intervalo es estado de proceso). */
export function reiniciarAlertas(): void {
  ultimoEnvio.clear();
  suprimidas.clear();
}
