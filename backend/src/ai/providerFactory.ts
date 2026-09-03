import { AnthropicChat } from './providers/anthropic';
import { OllamaChat, OllamaEmbedding } from './providers/ollama';
import { OpenAiChat, OpenAiEmbedding } from './providers/openai';
import { OpenAiVision } from './providers/openaiVision';
import type { ChatProvider, EmbeddingProvider, NombreProveedor, VisionProvider } from './types';

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
      return new OllamaEmbedding();
    case 'openai':
      return new OpenAiEmbedding(false);
    case 'azure':
      return new OpenAiEmbedding(true);
    default:
      throw new Error(
        `EMBEDDING_PROVIDER="${nombre}" no es válido. Opciones: ${PROVEEDORES_EMBEDDING.join(', ')}.`,
      );
  }
}

export function crearChatProvider(nombre = proveedorChatConfigurado()): ChatProvider {
  switch (nombre) {
    case 'ollama':
      return new OllamaChat();
    case 'openai':
      return new OpenAiChat(false);
    case 'azure':
      return new OpenAiChat(true);
    case 'anthropic':
      return new AnthropicChat();
    default:
      throw new Error(
        `CHAT_PROVIDER="${nombre}" no es válido. Opciones: ${PROVEEDORES_CHAT.join(', ')}.`,
      );
  }
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

/** ¿Se puede embeber ahora mismo, o falta configuración? */
export function embeddingsDisponibles(): { disponible: boolean; motivo: string | null } {
  const problemas = revisarConfiguracionIA().filter(
    (p) => p.variable !== 'CHAT_PROVIDER' && !p.variable.includes('CHAT'),
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
    (p) => p.variable !== 'EMBEDDING_PROVIDER' && p.variable !== 'AZURE_EMBED_DEPLOYMENT',
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
