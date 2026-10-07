import { AnthropicChat } from './providers/anthropic';
import { OllamaChat, OllamaEmbedding } from './providers/ollama';
import { OpenAiChat, OpenAiEmbedding } from './providers/openai';
import { OpenAiVision } from './providers/openaiVision';
import { CohereRerank, TeiRerank } from './providers/rerank';
import type { ChatProvider, EmbeddingProvider, NombreProveedor, RerankProvider, VisionProvider } from './types';
import { paso } from '../observabilidad/traza';

/**
 * Selección de proveedor por configuración.
 *
 * Chat y embeddings se eligen **por separado** (decisión D2): Anthropic no tiene embeddings, y la
 * recomendación de gobernanza es justo la mezcla — chat con un proveedor externo y embeddings en
 * local, porque el corpus entero pasa por embeddings mientras que el chat solo ve 12 chunks.
 */

export const PROVEEDORES_EMBEDDING: NombreProveedor[] = ['ollama', 'openai', 'azure'];
export const PROVEEDORES_CHAT: NombreProveedor[] = ['ollama', 'openai', 'azure', 'anthropic'];

export interface ProblemaConfiguracion {
  variable: string;
  mensaje: string;
}

function leer(nombre: string): string {
  return (process.env[nombre] ?? '').trim();
}

export function proveedorEmbeddingConfigurado(): NombreProveedor {
  return (leer('EMBEDDING_PROVIDER') || 'ollama') as NombreProveedor;
}

export function proveedorChatConfigurado(): NombreProveedor {
  return (leer('CHAT_PROVIDER') || 'ollama') as NombreProveedor;
}

export function crearEmbeddingProvider(
  nombre = proveedorEmbeddingConfigurado(),
): EmbeddingProvider {
  switch (nombre) {
    case 'ollama':
      return instrumentarEmbedding(new OllamaEmbedding());
    case 'openai':
      return instrumentarEmbedding(new OpenAiEmbedding(false));
    case 'azure':
      return instrumentarEmbedding(new OpenAiEmbedding(true));
    default:
      throw new Error(
        `EMBEDDING_PROVIDER="${nombre}" no es válido. Opciones: ${PROVEEDORES_EMBEDDING.join(', ')}.`,
      );
  }
}

export function crearChatProvider(nombre = proveedorChatConfigurado()): ChatProvider {
  switch (nombre) {
    case 'ollama':
      return instrumentarChat(new OllamaChat());
    case 'openai':
      return instrumentarChat(new OpenAiChat(false));
    case 'azure':
      return instrumentarChat(new OpenAiChat(true));
    case 'anthropic':
      return instrumentarChat(new AnthropicChat());
    default:
      throw new Error(
        `CHAT_PROVIDER="${nombre}" no es válido. Opciones: ${PROVEEDORES_CHAT.join(', ')}.`,
      );
  }
}

/**
 * Modelo RÁPIDO para las transformaciones de la consulta (docs/PLAN-RAG-AVANZADO.md, Fase 4):
 * planificador e HyDE son llamadas cortas que no necesitan el modelo de la respuesta y suman latencia
 * antes de buscar. `CHAT_PLANIFICADOR_PROVIDER` (por defecto el de chat) + `CHAT_PLANIFICADOR_MODEL`.
 * Sin ninguna de las dos devuelve `null`: quien llama usa el proveedor de chat, como antes.
 */
export function crearChatProviderRapido(): ChatProvider | null {
  return crearChatProviderAparte('CHAT_PLANIFICADOR');
}

/**
 * Modelo del JUEZ de calidad (Fase 5): `CHAT_JUEZ_PROVIDER` + `CHAT_JUEZ_MODEL`. Conviene que sea uno
 * igual o más capaz que el de chat (un juez más débil que el juzgado no detecta sus errores). Sin
 * configurar, el de chat.
 */
export function crearChatProviderJuez(): ChatProvider {
  return crearChatProviderAparte('CHAT_JUEZ') ?? crearChatProvider();
}

/** `<prefijo>_PROVIDER` / `<prefijo>_MODEL`: un proveedor de chat distinto del principal, o `null`. */
function crearChatProviderAparte(prefijo: string): ChatProvider | null {
  const proveedor = (leer(`${prefijo}_PROVIDER`) || '') as NombreProveedor | '';
  const modelo = leer(`${prefijo}_MODEL`);
  if (!proveedor && !modelo) return null;
  const nombre = (proveedor || proveedorChatConfigurado()) as NombreProveedor;
  switch (nombre) {
    case 'ollama':
      return instrumentarChat(new OllamaChat(modelo || undefined));
    case 'openai':
      return instrumentarChat(new OpenAiChat(false, modelo || undefined));
    case 'azure':
      return instrumentarChat(new OpenAiChat(true, modelo || undefined));
    case 'anthropic':
      return instrumentarChat(new AnthropicChat(modelo || undefined));
    default:
      throw new Error(
        `${prefijo}_PROVIDER="${nombre}" no es válido. Opciones: ${PROVEEDORES_CHAT.join(', ')}.`,
      );
  }
}

/**
 * Cómo se reordenan los candidatos de RRF antes de armar el contexto (docs/PLAN-RAG-AVANZADO.md,
 * Fase 3): `local` = cross-encoder en TEI (recomendado, nada sale del servidor), `cohere` = API de
 * Cohere, `llm` = el modelo de chat ordena una lista (el comportamiento anterior a la Fase 3, y el
 * valor por defecto para que actualizar no rompa una instalación sin el servicio `reranker`),
 * `ninguno` = se conserva el orden de RRF.
 */
export const METODOS_RERANK = ['local', 'cohere', 'llm', 'ninguno'] as const;
export type MetodoRerank = (typeof METODOS_RERANK)[number];

export function metodoRerankConfigurado(): MetodoRerank {
  const valor = leer('RAG_RERANK_PROVIDER') || 'llm';
  return (METODOS_RERANK as readonly string[]).includes(valor) ? (valor as MetodoRerank) : 'llm';
}

/** Cross-encoder del método dado; `null` para `llm`/`ninguno`, que no usan uno. */
export function crearRerankProvider(metodo: MetodoRerank = metodoRerankConfigurado()): RerankProvider | null {
  switch (metodo) {
    case 'local':
      return instrumentarRerank(new TeiRerank());
    case 'cohere':
      return instrumentarRerank(new CohereRerank());
    default:
      return null;
  }
}

/**
 * Cada llamada al modelo queda como paso `generacion` de la traza en curso (modelo, mensajes,
 * respuesta y tokens), sin que planificador, rerank o respuesta tengan que registrarlo. Fuera de una
 * traza (ingesta, scripts) `paso` es un no-op. Ver compartido/observabilidad/traza.ts.
 */
export function instrumentarChat(p: ChatProvider): ChatProvider {
  return {
    nombre: p.nombre,
    modelo: p.modelo,
    comprobar: () => p.comprobar(),
    responder: (mensajes, opciones) => paso(
      `llm ${p.nombre}/${p.modelo}`,
      { mensajes, maxTokens: opciones?.maxTokens },
      () => p.responder(mensajes, opciones),
      {
        tipo: 'generacion',
        resumir: (r) => ({ salida: r.texto, modelo: p.modelo, tokensIn: r.uso.tokensIn, tokensOut: r.uso.tokensOut }),
      },
    ),
  };
}

export function instrumentarEmbedding(p: EmbeddingProvider): EmbeddingProvider {
  return {
    nombre: p.nombre,
    modelo: p.modelo,
    dimension: p.dimension,
    comprobar: () => p.comprobar(),
    embeber: (textos) => paso(
      `embedding ${p.nombre}/${p.modelo}`,
      // Solo el comienzo de cada texto: el vector no aporta nada a la traza y el texto entero tampoco.
      { textos: textos.map((t) => t.slice(0, 300)), cantidad: textos.length },
      () => p.embeber(textos),
      { tipo: 'embedding', resumir: (r) => ({ modelo: p.modelo, tokensIn: r.uso.tokensIn, salida: { vectores: r.vectores.length } }) },
    ),
  };
}

export function instrumentarRerank(p: RerankProvider): RerankProvider {
  return {
    nombre: p.nombre,
    modelo: p.modelo,
    comprobar: () => p.comprobar(),
    puntuar: (consulta, textos) => paso(
      `cross-encoder ${p.nombre}/${p.modelo}`,
      { consulta, textos: textos.length },
      () => p.puntuar(consulta, textos),
      { resumir: (puntajes) => ({ modelo: p.modelo, salida: { puntajes: puntajes.map((x) => Math.round(x * 1000) / 1000) } }) },
    ),
  };
}

/**
 * Comprueba que lo configurado es coherente y que están las claves necesarias.
 *
 * No hace ninguna llamada: solo mira la configuración. Se ejecuta al arrancar para que un
 * proveedor mal configurado se vea en el log en vez de manifestarse como "falla el chat" cuando
 * alguien lo use. Devuelve la lista de problemas en vez de lanzar, porque hoy es normal no tener
 * claves todavía y eso no debe impedir arrancar: la ingesta sí puede convertir y trocear sin ellas.
 */
export function revisarConfiguracionIA(): ProblemaConfiguracion[] {
  const problemas: ProblemaConfiguracion[] = [];
  const embedding = proveedorEmbeddingConfigurado();
  const chat = proveedorChatConfigurado();

  if (!PROVEEDORES_EMBEDDING.includes(embedding)) {
    problemas.push({
      variable: 'EMBEDDING_PROVIDER',
      mensaje:
        embedding === 'anthropic'
          ? 'Anthropic NO tiene endpoint de embeddings. Use ollama, openai o azure.'
          : `Valor "${embedding}" no válido. Opciones: ${PROVEEDORES_EMBEDDING.join(', ')}.`,
    });
  }

  if (!PROVEEDORES_CHAT.includes(chat)) {
    problemas.push({
      variable: 'CHAT_PROVIDER',
      mensaje: `Valor "${chat}" no válido. Opciones: ${PROVEEDORES_CHAT.join(', ')}.`,
    });
  }

  for (const proveedor of new Set([embedding, chat])) {
    problemas.push(...revisarProveedor(proveedor));
  }

  // Modelo rápido y juez: si apuntan a otro proveedor, ese proveedor también necesita sus claves.
  const aparte: [string, string][] = [
    ['CHAT_PLANIFICADOR_PROVIDER', 'Sin ella el planificador reintenta con el modelo de chat.'],
    ['CHAT_JUEZ_PROVIDER', 'Sin ella los juicios de calidad quedan con error.'],
  ];
  for (const [variable, consecuencia] of aparte) {
    const otro = leer(variable) as NombreProveedor;
    if (!otro) continue;
    if (!PROVEEDORES_CHAT.includes(otro)) {
      problemas.push({ variable, mensaje: `Valor "${otro}" no válido. Opciones: ${PROVEEDORES_CHAT.join(', ')}.` });
    } else if (otro !== chat && otro !== embedding) {
      problemas.push(...revisarProveedor(otro).map((p) => ({ variable, mensaje: `${p.variable}: ${p.mensaje} ${consecuencia}` })));
    }
  }

  // Rerank: un valor inválido o cohere sin clave no impiden responder (se degrada al orden de RRF),
  // pero sin este aviso solo se notaría por respuestas peores.
  const rerank = leer('RAG_RERANK_PROVIDER');
  if (rerank && !(METODOS_RERANK as readonly string[]).includes(rerank)) {
    problemas.push({
      variable: 'RAG_RERANK_PROVIDER',
      mensaje: `Valor "${rerank}" no válido (se usa llm). Opciones: ${METODOS_RERANK.join(', ')}.`,
    });
  }
  if (rerank === 'cohere' && !leer('COHERE_API_KEY')) {
    problemas.push({ variable: 'COHERE_API_KEY', mensaje: 'Necesaria para RAG_RERANK_PROVIDER=cohere (sin ella se usa el orden de RRF).' });
  }

  return problemas;
}

function revisarProveedor(proveedor: NombreProveedor): ProblemaConfiguracion[] {
  const faltan: ProblemaConfiguracion[] = [];
  const exigir = (variable: string, ayuda: string) => {
    if (!leer(variable)) faltan.push({ variable, mensaje: ayuda });
  };

  switch (proveedor) {
    case 'ollama':
      // No necesita clave. Si no está levantado se verá al comprobar, no aquí.
      break;
    case 'openai':
      exigir('OPENAI_API_KEY', 'Necesaria para usar OpenAI (chat o embeddings).');
      break;
    case 'anthropic':
      exigir('ANTHROPIC_API_KEY', 'Necesaria para usar Anthropic como proveedor de chat.');
      break;
    case 'azure':
      exigir('AZURE_OPENAI_ENDPOINT', 'URL del recurso de Azure OpenAI.');
      exigir('AZURE_OPENAI_API_KEY', 'Clave del recurso de Azure OpenAI.');
      // Azure enruta por deployment, no por nombre de modelo.
      if (proveedorEmbeddingConfigurado() === 'azure') {
        exigir('AZURE_EMBED_DEPLOYMENT', 'Nombre del deployment de embeddings en Azure.');
      }
      if (proveedorChatConfigurado() === 'azure') {
        exigir('AZURE_CHAT_DEPLOYMENT', 'Nombre del deployment de chat en Azure.');
      }
      break;
  }

  return faltan;
}

/** Rerank y modelo rápido degradan solos (orden de RRF / modelo de chat): sus avisos se muestran,
 *  pero no apagan el chat ni los embeddings. */
function esAvisoNoBloqueante(p: ProblemaConfiguracion): boolean {
  return ['RAG_RERANK_PROVIDER', 'COHERE_API_KEY', 'CHAT_PLANIFICADOR_PROVIDER', 'CHAT_JUEZ_PROVIDER'].includes(p.variable);
}

/** ¿Se puede embeber ahora mismo, o falta configuración? */
export function embeddingsDisponibles(): { disponible: boolean; motivo: string | null } {
  const problemas = revisarConfiguracionIA().filter(
    (p) => p.variable !== 'CHAT_PROVIDER' && !p.variable.includes('CHAT') && !esAvisoNoBloqueante(p),
  );

  if (problemas.length > 0) {
    return {
      disponible: false,
      motivo: problemas.map((p) => `${p.variable}: ${p.mensaje}`).join(' | '),
    };
  }

  return { disponible: true, motivo: null };
}

/** Simétrico a `embeddingsDisponibles()`, para el chat (Fase 5). */
export function chatDisponible(): { disponible: boolean; motivo: string | null } {
  const problemas = revisarConfiguracionIA().filter(
    (p) => p.variable !== 'EMBEDDING_PROVIDER' && p.variable !== 'AZURE_EMBED_DEPLOYMENT' && !esAvisoNoBloqueante(p),
  );

  if (problemas.length > 0) {
    return {
      disponible: false,
      motivo: problemas.map((p) => `${p.variable}: ${p.mensaje}`).join(' | '),
    };
  }

  return { disponible: true, motivo: null };
}

/**
 * ¿Se puede extraer texto con IA de visión ahora mismo? Depende solo de `OPENAI_API_KEY` — la
 * capacidad es exclusiva de OpenAI (`OpenAiVision` siempre usa su endpoint, nunca Azure), y es
 * independiente de `CHAT_PROVIDER`/`EMBEDDING_PROVIDER`, que seleccionan capacidades distintas y
 * podrían apuntar a otro proveedor sin que eso deba bloquear esta.
 */
export function visionDisponible(): { disponible: boolean; motivo: string | null } {
  if (!leer('OPENAI_API_KEY')) {
    return {
      disponible: false,
      motivo: 'OPENAI_API_KEY: Necesaria para la extracción de texto con IA (visión).',
    };
  }
  return { disponible: true, motivo: null };
}

export function crearVisionProvider(): VisionProvider {
  return new OpenAiVision();
}
