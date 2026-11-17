import type { Sequelize } from 'sequelize';
import { leerConfig } from './configService';

/**
 * Cierre del chat a lo que hay en los datos (docs/PLAN-CHAT-CONSULTAS.md, D3): todo lo que no sea
 * una pregunta sobre la base de conocimiento recibe un mensaje FIJO, sin llamar al modelo de
 * respuesta. Tres puntos de corte, del más barato al más caro:
 *
 *   1. `filtroGratis` — reglas sobre el texto (saludos, agradecimientos, "qué puedes hacer"). 0 tokens.
 *   2. El planificador clasifica `fuera_de_alcance` — una llamada corta, sin la respuesta cara.
 *   3. La búsqueda no encuentra nada — no hay de qué responder, así que no se pregunta al modelo.
 *
 * Los textos viven en `app.config` para poder ajustarlos sin redesplegar; si falta la fila se usa el
 * valor por defecto de aquí (la migración 018 los siembra con estos mismos textos).
 */

export type MotivoFijo = 'ayuda' | 'fuera_de_alcance' | 'sin_resultados';

export const MENSAJES_FIJOS_POR_DEFECTO: Record<MotivoFijo, string> = {
  ayuda:
    'Respondo solo sobre la información de la base de conocimiento: expedientes, documentos, '
    + 'remitentes, indicaciones y su contenido. Por ejemplo: "dame los expedientes de la obra '
    + 'Huancavelica" o "¿qué dice el último informe de controversia?".',
  fuera_de_alcance:
    'Esa consulta no es sobre la información de la base de conocimiento, así que no puedo '
    + 'responderla. Pregúnteme por expedientes, documentos, remitentes o su contenido.',
  sin_resultados:
    'No encontré información sobre eso en la base de conocimiento.',
};

const CLAVE_CONFIG: Record<MotivoFijo, string> = {
  ayuda: 'chat.mensaje_ayuda',
  fuera_de_alcance: 'chat.mensaje_fuera_alcance',
  sin_resultados: 'chat.mensaje_sin_resultados',
};

export async function mensajeFijo(motivo: MotivoFijo, db?: Sequelize): Promise<string> {
  try {
    const valor = await leerConfig(CLAVE_CONFIG[motivo], db);
    if (valor && valor.trim()) return valor.trim();
  } catch {
    // Sin acceso a app.config (BD caída a medias): el texto por defecto es igual de válido, y un
    // mensaje fijo nunca debe ser el motivo de que falle un turno.
  }
  return MENSAJES_FIJOS_POR_DEFECTO[motivo];
}

/**
 * Mensajes que NO son una consulta: se contestan sin gastar ni la llamada del planificador.
 *
 * Solo se reconoce el mensaje COMPLETO (anclado con ^…$) y corto: "hola, dame los expedientes de
 * Junín" empieza con un saludo pero es una consulta real, y tiene que llegar al planificador.
 */
const PATRONES_TRIVIALES = [
  /^(hola|buen[oa]s?( (d[ií]as|tardes|noches))?|hey|saludos|qu[eé] tal)$/,
  /^(gracias|muchas gracias|ok|okay|vale|listo|perfecto|entendido|de acuerdo|genial|chau|adi[oó]s|hasta luego)$/,
  /^(ayuda|help|qu[eé] (puedes|sabes) hacer|c[oó]mo funcionas|qu[eé] eres|qui[eé]n eres|para qu[eé] sirves)$/,
];

export function filtroGratis(mensaje: string): MotivoFijo | null {
  const normalizado = mensaje
    .toLowerCase()
    .replace(/[¿?¡!.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalizado || normalizado.length > 40) return null;
  return PATRONES_TRIVIALES.some((p) => p.test(normalizado)) ? 'ayuda' : null;
}
