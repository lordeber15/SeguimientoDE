import { z } from 'zod';
import type { ChatProvider, MensajeChat, ResultadoChat } from '../ai/types';
import { alertar } from '../observabilidad/alertas';
import { conReintentos, paso } from '../observabilidad/traza';

/**
 * Planificador del chat (docs/PLAN-CHAT-CONSULTAS.md, Fase 2): una llamada CORTA al modelo que,
 * antes de buscar nada, decide qué tipo de pregunta es y extrae sus filtros. Es lo que permite
 * responder "dame los expedientes de Junín" con un listado SQL en vez de 20 fragmentos sueltos, y
 * cerrar con un mensaje fijo lo que no es sobre los datos sin pagar la respuesta cara.
 *
 * JSON en el texto y no tool calling: funciona igual con los 4 proveedores (Ollama/qwen no hace
 * tool calling fiable) sin tocar sus adaptadores.
 *
 * Degrada con seguridad, igual que el rerank: si el proveedor falla o la respuesta no es un JSON
 * válido, el plan es `contenido` con la pregunta tal cual — el comportamiento que el chat tenía
 * antes de existir el planificador. Un planificador roto nunca tumba el chat ni cierra una
 * pregunta válida.
 */

export const INTENCIONES = [
  'listar',
  'contar',
  'ultimo_documento',
  'participantes',
  'agrupar',
  'contenido',
  'fuera_de_alcance',
] as const;

export type Intencion = (typeof INTENCIONES)[number];

const textoONull = z
  .string()
  .nullish()
  .transform((v) => (v && v.trim() ? v.trim() : null));

const listaTerminos = z
  .array(z.string())
  .nullish()
  .transform((v) => (v ?? []).map((t) => t.trim()).filter(Boolean));

/** Lenient a propósito: un campo ausente o en null toma su valor neutro en vez de invalidar el plan. */
const esquemaPlan = z.object({
  intencion: z.enum(INTENCIONES),
  consulta: textoONull,
  terminos: z
    .object({
      obligatorios: listaTerminos,
      opcionales: listaTerminos,
      // Un valor mal formado no invalida el plan: los sinónimos son una ayuda, no un requisito.
      sinonimos: z.record(z.unknown()).nullish().catch(null).transform((v) => {
        const limpio: Record<string, string[]> = {};
        for (const [k, lista] of Object.entries(v ?? {})) {
          if (!Array.isArray(lista)) continue;
          const textos = lista.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
          if (k.trim() && textos.length > 0) limpio[k.trim()] = textos.slice(0, 3);
        }
        return limpio;
      }),
    })
    .nullish()
    .transform((v) => v ?? { obligatorios: [], opcionales: [], sinonimos: {} }),
  filtros: z
    .object({
      remitente: textoONull,
      emisor: textoONull,
      dependencia: textoONull,
      tipo_doc: textoONull,
      desde: textoONull,
      hasta: textoONull,
      actual: z.boolean().nullish().transform((v) => v ?? false),
    })
    .partial()
    .nullish()
    .transform((v) => ({
      remitente: v?.remitente ?? null,
      emisor: v?.emisor ?? null,
      dependencia: v?.dependencia ?? null,
      tipoDoc: v?.tipo_doc ?? null,
      desde: v?.desde ?? null,
      hasta: v?.hasta ?? null,
      actual: v?.actual ?? false,
    })),
  continua_anterior: z.boolean().nullish().transform((v) => v ?? false),
  subconsultas: listaTerminos,
});

/** Tope de subconsultas: cada una es un retrieval completo en paralelo (2 conexiones + un embedding). */
export const MAX_SUBCONSULTAS = 3;

export interface PlanConsulta {
  intencion: Intencion;
  /** Pregunta autónoma (ya resuelta contra el historial). Nunca vacía: cae al mensaje original. */
  consulta: string;
  /** `sinonimos`: término obligatorio → otras formas de decirlo en los documentos ("alquiler" →
   *  ["arrendamiento"]). Se suman a los de `chat.sinonimos` (Fase 6). */
  terminos: { obligatorios: string[]; opcionales: string[]; sinonimos?: Record<string, string[]> };
  filtros: {
    remitente: string | null;
    emisor: string | null;
    dependencia: string | null;
    tipoDoc: string | null;
    desde: string | null;
    hasta: string | null;
    actual: boolean;
  };
  continuaAnterior: boolean;
  /** Pregunta compuesta (Fase 4, decomposition): una pregunta autónoma por cada cosa que pide, máx.
   *  `MAX_SUBCONSULTAS`. Vacío si es simple: entonces se busca solo `consulta`. */
  subconsultas: string[];
}

export interface ResultadoPlanificador {
  plan: PlanConsulta;
  uso: ResultadoChat['uso'] | null;
  /** true si se usó el plan de respaldo (proveedor caído o respuesta no interpretable). */
  respaldo: boolean;
  ms: number;
  /** Solo con respaldo, para diagnosticar: la salida del modelo que no se pudo interpretar, o el error. */
  diagnostico?: string;
  /** Modelo que produjo el plan (el rápido, o el de chat si el rápido falló o no hay). */
  modelo?: string;
}

export interface ContextoPlanificador {
  /** 'expediente' = el usuario ya está dentro de UN expediente (SGD) o documento (STD): todo se
   *  interpreta sobre él. */
  modo: 'general' | 'expediente';
  /** Turnos previos de la misma sesión, del más viejo al más nuevo. Se recortan aquí. */
  historial: MensajeChat[];
}

const MAX_TURNOS_HISTORIAL = 6;
const MAX_CHARS_POR_TURNO = 400;
const MAX_TOKENS_PLAN = 400;

export function planDeRespaldo(mensaje: string): PlanConsulta {
  return {
    intencion: 'contenido',
    consulta: mensaje.trim(),
    terminos: { obligatorios: [], opcionales: [] },
    filtros: {
      remitente: null, emisor: null, dependencia: null, tipoDoc: null,
      desde: null, hasta: null, actual: false,
    },
    continuaAnterior: false,
    subconsultas: [],
  };
}

const PROMPT_SISTEMA = `Clasificas preguntas para un buscador de expedientes y documentos de trámite \
documentario de una entidad pública (oficios, informes, cartas, contratos, obras, proyectos, \
controversias, remitentes, indicaciones). NO respondes la pregunta: devuelves SOLO un objeto JSON, \
sin texto antes ni después, sin markdown.

Intenciones:
- "listar": pide expedientes/documentos que cumplan algo ("dame los expedientes de…", "lista…", "busca…").
- "contar": pide cuántos ("¿cuántos expedientes…?").
- "ultimo_documento": pide el último / más reciente documento de algo.
- "participantes": pide QUIÉNES participaron, intervinieron, firmaron, remitieron o recibieron. \
"¿En cuáles participó X?" pide expedientes, no personas: es "listar" con filtros.remitente X.
- "agrupar": pide QUÉ OBRAS / PROYECTOS / TEMAS (no qué expedientes) cumplen algo ("¿qué obras \
tienen controversias?"). "¿Qué expedientes hablan de…?" es "listar", no "agrupar".
- "contenido": pregunta sobre lo que DICEN los documentos (montos, plazos, motivos, estado, resúmenes).
- "fuera_de_alcance": no tiene relación con expedientes, documentos o trámites de la entidad \
(cultura general, programación, chistes, opiniones, matemáticas, redactar textos libres, el clima…).
Ante la duda entre "contenido" y "fuera_de_alcance", elige "contenido".
Son SIEMPRE del alcance (nunca "fuera_de_alcance") los temas de gestión pública y contrataciones: \
adjudicación, buena pro, licitación, concurso, comparación de precios, proceso de selección, \
contratación directa, órdenes de compra o de servicio, requerimientos, pagos, conformidades, \
penalidades, garantías, adendas, liquidaciones, presupuesto, personal, convenios. Un mensaje corto \
que solo nombra un tema ("comparación de precios", "de adjudicaciones") o que corrige/precisa la \
pregunta anterior es una consulta sobre los documentos: "listar" si antes se pidieron expedientes, \
si no "contenido". Decide por la pregunta, no por lo que respondió antes el asistente.

Campos:
- "consulta": la pregunta reescrita para que se entienda SOLA, resolviendo referencias al historial \
("¿y el último?" → "último documento de controversia de la obra Huancavelica").
- "terminos.obligatorios": TODAS las palabras clave de la pregunta: el lugar u obra Y el tema \
(controversia, alquiler, computadoras, penalidad, adenda…). Si la pregunta dice "controversia de la \
obra Junín", los dos son obligatorios: ["controversia", "Junín"]. Conserva juntas las expresiones \
de varias palabras ("in house", "China Civil"). Nunca incluyas palabras genéricas: "expediente(s)", \
"documento(s)", "obra", "proyecto(s)", "relacionado", "dame", "todos", "último".
- "terminos.opcionales": palabras que ayudan pero no son imprescindibles.
- "terminos.sinonimos": para cada término obligatorio que los documentos oficiales suelen escribir de \
otra forma, esas formas (máximo 3, sinónimos EXACTOS, no temas relacionados): {"alquiler": \
["arrendamiento"], "computadoras": ["equipos de cómputo"]}. Lugares, nombres propios y siglas no \
llevan sinónimos. Si no hay, {}.
- "filtros.remitente": empresa o persona SOLO si la pregunta dice que presentó/envió/remitió \
documentos ("donde la empresa X presentó documentos" → "X"). Si solo dice "relacionados con X", va en términos.
- "filtros.emisor": PERSONA interna que emitió o firmó, si se pide explícitamente.
- "filtros.dependencia": OFICINA, área, unidad o dirección interna que emitió ("los informes de la \
Oficina de Asesoría Legal" → "Oficina de Asesoría Legal"; "lo que envió logística" → "logística").
- "filtros.tipo_doc" (OFICIO, INFORME, CARTA…): SOLO si se piden documentos de ese tipo ("los \
oficios de…", "el último informe de…"). "El monto del contrato" habla de un tema: tipo_doc = null.
- "filtros.desde"/"filtros.hasta": fechas AAAA-MM-DD si se pide un rango.
- "filtros.actual": true si pide lo "actual", "vigente", "en curso", "actualmente".
- "subconsultas": SOLO si la intención es "contenido" y la pregunta pide DOS O MÁS datos distintos \
("¿cuál es el monto del contrato y quién firmó la adenda?"): una pregunta autónoma por cada dato, \
máximo 3, cada una con la obra/lugar/expediente que corresponda. Si pide una sola cosa, [].
- "continua_anterior": true si la pregunta se refiere a lo que se acaba de listar o conversar: \
usa "esos", "ellos", "ahí", "de ellos", "en cuáles", "cuáles de", "y el último", o pregunta un \
detalle (quiénes, cuándo, qué dicen, el último) sin nombrar otra obra o lugar. false si REEMPLAZA \
la obra o el lugar anterior por otro ("¿y los de Huancavelica?", "¿y en Puno?", "ahora los de…"), \
o si no hay historial. Filtrar lo anterior por una empresa o un tema ("¿en cuáles participó X?", \
"¿cuáles hablan de penalidades?") sí es true.

Ejemplos (solo los campos relevantes; tu salida SIEMPRE lleva el formato completo):
- "dale los expedientes que contengan controversia en la obra huancavelica" → intencion "listar", \
obligatorios ["controversia", "Huancavelica"].
- "dame todos los expedientes del alquiler de computadoras para el in house" → "listar", \
obligatorios ["alquiler", "computadoras", "in house"], sinonimos {"alquiler": ["arrendamiento"], \
"computadoras": ["equipos de cómputo"]}.
- "dame los expedientes de adjudicación de un proceso de comparación de precios" → "listar", \
obligatorios ["adjudicación", "comparación de precios"], sinonimos {"adjudicación": ["buena pro", \
"otorgamiento de la buena pro"]}.
- (tras esa pregunta) "de comparación de precios" → "listar", obligatorios ["comparación de precios"].
- "dame todos los expedientes relacionados con proyectos in house" → "listar", obligatorios \
["in house"] ("proyectos" es genérico).
- "quiénes participaron en las controversias de la obra Junín" → "participantes", \
obligatorios ["controversia", "Junín"].
- "listame los expedientes donde la empresa China Civil presentó documentos" → "listar", \
obligatorios ["China Civil"], filtros.remitente "China Civil".
- "¿cuál es el último documento que presentó China Civil?" → "ultimo_documento", obligatorios \
["China Civil"], filtros.remitente "China Civil".
- "¿qué obras tienen controversias actualmente?" → "agrupar", obligatorios ["controversia"], \
filtros.actual true.
- (tras un listado) "¿y en cuáles participó China Civil?" → "listar", obligatorios ["China Civil"], \
filtros.remitente "China Civil", continua_anterior true.
- "¿cuál es el monto del contrato de la obra de Junín?" → "contenido", obligatorios ["monto", \
"contrato", "Junín"], tipo_doc null.
- (tras listar los expedientes de Junín) "¿qué dicen sobre la resolución del contrato?" → \
"contenido", obligatorios ["resolución del contrato"], continua_anterior true.
- (tras listar los expedientes de Junín) "¿y los de Huancavelica?" → "listar", obligatorios \
["Huancavelica"], continua_anterior false (otra obra).
- "¿cuál es el plazo de la obra de Junín y qué penalidades se aplicaron?" → "contenido", subconsultas \
["¿cuál es el plazo de ejecución de la obra de Junín?", "¿qué penalidades se aplicaron en la obra de Junín?"].

Formato exacto:
{"intencion":"…","consulta":"…","terminos":{"obligatorios":[],"opcionales":[],"sinonimos":{}},\
"filtros":{"remitente":null,"emisor":null,"dependencia":null,"tipo_doc":null,"desde":null,"hasta":null,"actual":false},\
"continua_anterior":false,"subconsultas":[]}`;

const NOTA_MODO_EXPEDIENTE = `\n\nEl usuario está conversando dentro de UN expediente o documento \
concreto: toda pregunta sobre documentos, estado o contenido se refiere a él. Usa "contenido" \
para casi todo y "fuera_de_alcance" solo si no tiene relación con trámites o documentos.`;

function construirEntrada(mensaje: string, historial: MensajeChat[]): string {
  const turnos = historial
    .filter((m) => m.rol !== 'system')
    .slice(-MAX_TURNOS_HISTORIAL)
    .map((m) => {
      const texto = m.contenido.replace(/\s+/g, ' ').trim();
      const recortado = texto.length > MAX_CHARS_POR_TURNO ? `${texto.slice(0, MAX_CHARS_POR_TURNO)}…` : texto;
      return `${m.rol === 'user' ? 'Usuario' : 'Asistente'}: ${recortado}`;
    });

  return (turnos.length > 0 ? `Historial reciente:\n${turnos.join('\n')}\n\n` : 'Historial reciente: (ninguno)\n\n')
    + `Pregunta nueva: ${mensaje.trim()}`;
}

/**
 * Primer objeto JSON balanceado del texto. Tolera lo que los modelos añaden aunque se les pida que
 * no: ```json … ```, una frase antes, o texto después del cierre.
 */
export function extraerJson(texto: string): unknown | null {
  const inicio = texto.indexOf('{');
  if (inicio < 0) return null;

  let profundidad = 0;
  let enCadena = false;
  let escapado = false;
  for (let i = inicio; i < texto.length; i++) {
    const c = texto[i];
    if (enCadena) {
      if (escapado) escapado = false;
      else if (c === '\\') escapado = true;
      else if (c === '"') enCadena = false;
      continue;
    }
    if (c === '"') enCadena = true;
    else if (c === '{') profundidad++;
    else if (c === '}') {
      profundidad--;
      if (profundidad === 0) {
        try {
          return JSON.parse(texto.slice(inicio, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Valida y normaliza la salida del modelo. `null` si no es un plan utilizable. */
export function interpretarPlan(texto: string, mensajeOriginal: string): PlanConsulta | null {
  const crudo = extraerJson(texto);
  if (crudo === null) return null;

  const resultado = esquemaPlan.safeParse(crudo);
  if (!resultado.success) return null;

  const p = resultado.data;
  const consulta = p.consulta ?? mensajeOriginal.trim();
  // Solo tiene sentido descomponer una pregunta de contenido en 2+ partes distintas de la consulta.
  const subconsultas = p.intencion === 'contenido'
    ? [...new Set(p.subconsultas)].filter((q) => q.toLowerCase() !== consulta.toLowerCase()).slice(0, MAX_SUBCONSULTAS)
    : [];
  return {
    intencion: p.intencion,
    consulta,
    terminos: p.terminos,
    filtros: p.filtros,
    continuaAnterior: p.continua_anterior,
    subconsultas: subconsultas.length >= 2 ? subconsultas : [],
  };
}

/** El planificador es un paso corto antes de buscar: con el proveedor caído conviene caer al plan de
 *  respaldo rápido en vez de esperar 2 reintentos con backoff (ver compartido/ai/http.ts). */
const REINTENTOS_PLANIFICADOR = 1;

/**
 * `provider` es el modelo con el que se planifica (el rápido, Fase 4, si está configurado) y
 * `respaldo`, el modelo de chat: si el rápido falla o no devuelve un plan, se reintenta UNA vez con él
 * antes de caer al plan de respaldo — un modelo pequeño que no sigue el formato no debe dejar al chat
 * sin reescritura ni intención.
 */
export async function planificar(
  provider: ChatProvider,
  mensaje: string,
  contexto: ContextoPlanificador,
  respaldo?: ChatProvider,
): Promise<ResultadoPlanificador> {
  const r = await paso(
    'planificador',
    { mensaje, modo: contexto.modo, turnosHistorial: contexto.historial.length, modelo: provider.modelo },
    async () => {
      const primero = await conReintentos(REINTENTOS_PLANIFICADOR, () => planificarSinTraza(provider, mensaje, contexto));
      if (!primero.respaldo || !respaldo || respaldo === provider) return primero;
      const segundo = await conReintentos(REINTENTOS_PLANIFICADOR, () => planificarSinTraza(respaldo, mensaje, contexto));
      const ms = primero.ms + segundo.ms;
      // Si ninguno dio un plan, se informa el diagnóstico del primero (el que se quería usar).
      return segundo.respaldo ? { ...primero, ms } : { ...segundo, ms };
    },
    {
      resumir: (x) => ({
        salida: { plan: x.plan, respaldo: x.respaldo, diagnostico: x.diagnostico },
        nivel: x.respaldo ? 'WARNING' : 'DEFAULT',
      }),
    },
  );
  // Un proveedor caído ya lo alerta el cliente HTTP; esto es el otro caso: respondió, pero no un plan.
  if (r.respaldo && r.diagnostico?.startsWith('salida no interpretable')) {
    alertar('planificador_json', 'el planificador devolvió una salida que no es un plan válido; se usó el de respaldo', {
      proveedor: provider.nombre, modelo: provider.modelo, diagnostico: r.diagnostico.slice(0, 300),
    });
  }
  return r;
}

async function planificarSinTraza(
  provider: ChatProvider,
  mensaje: string,
  contexto: ContextoPlanificador,
): Promise<ResultadoPlanificador> {
  const inicio = Date.now();
  try {
    const respuesta = await provider.responder(
      [
        {
          rol: 'system',
          contenido: PROMPT_SISTEMA + (contexto.modo === 'expediente' ? NOTA_MODO_EXPEDIENTE : ''),
        },
        { rol: 'user', contenido: construirEntrada(mensaje, contexto.historial) },
      ],
      { maxTokens: MAX_TOKENS_PLAN },
    );

    const plan = interpretarPlan(respuesta.texto, mensaje);
    return plan
      ? { plan, uso: respuesta.uso, respaldo: false, ms: Date.now() - inicio, modelo: provider.modelo }
      : {
        plan: planDeRespaldo(mensaje), uso: respuesta.uso, respaldo: true, ms: Date.now() - inicio,
        diagnostico: `salida no interpretable: ${respuesta.texto.slice(0, 600)}`,
      };
  } catch (e) {
    return {
      plan: planDeRespaldo(mensaje), uso: null, respaldo: true, ms: Date.now() - inicio,
      diagnostico: `error del proveedor: ${e instanceof Error ? e.message : String(e)}`.slice(0, 600),
    };
  }
}
