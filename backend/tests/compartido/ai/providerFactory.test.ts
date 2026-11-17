/**
 * Selección de proveedores de las Fases 3 y 4 (rerank y modelo rápido): qué se usa y que algo mal
 * configurado se avise al arrancar SIN apagar el chat ni los embeddings (ambos degradan solos).
 */

import {
  chatDisponible,
  crearChatProviderRapido,
  crearRerankProvider,
  embeddingsDisponibles,
  metodoRerankConfigurado,
  revisarConfiguracionIA,
} from '../../../src/compartido/ai/providerFactory';

const VARIABLES = [
  'RAG_RERANK_PROVIDER', 'COHERE_API_KEY', 'CHAT_PROVIDER', 'EMBEDDING_PROVIDER',
  'CHAT_PLANIFICADOR_PROVIDER', 'CHAT_PLANIFICADOR_MODEL', 'ANTHROPIC_API_KEY',
];
const previas = Object.fromEntries(VARIABLES.map((v) => [v, process.env[v]]));

beforeEach(() => {
  VARIABLES.forEach((v) => delete process.env[v]); // ollama/ollama: sin claves que exigir
});
afterAll(() => {
  for (const [v, valor] of Object.entries(previas)) {
    if (valor === undefined) delete process.env[v]; else process.env[v] = valor;
  }
});

describe('modelo rápido (Fase 4)', () => {
  it('sin configurar devuelve null: el planificador usa el modelo de chat', () => {
    expect(crearChatProviderRapido()).toBeNull();
  });

  it('solo el modelo: mismo proveedor que el chat, otro modelo', () => {
    process.env.CHAT_PLANIFICADOR_MODEL = 'qwen3:1.7b';
    expect(crearChatProviderRapido()).toMatchObject({ nombre: 'ollama', modelo: 'qwen3:1.7b' });
  });

  it('otro proveedor sin su clave: se avisa, pero no apaga el chat', () => {
    process.env.CHAT_PLANIFICADOR_PROVIDER = 'anthropic';
    expect(crearChatProviderRapido()?.nombre).toBe('anthropic');
    expect(revisarConfiguracionIA().map((p) => p.variable)).toContain('CHAT_PLANIFICADOR_PROVIDER');
    expect(chatDisponible().disponible).toBe(true);
  });
});

describe('rerank en providerFactory', () => {
  it('por defecto es llm, y un valor desconocido también cae a llm', () => {
    expect(metodoRerankConfigurado()).toBe('llm');
    process.env.RAG_RERANK_PROVIDER = 'colbert';
    expect(metodoRerankConfigurado()).toBe('llm');
  });

  it('solo local y cohere crean un cross-encoder', () => {
    expect(crearRerankProvider('local')?.nombre).toBe('tei');
    expect(crearRerankProvider('cohere')?.nombre).toBe('cohere');
    expect(crearRerankProvider('llm')).toBeNull();
    expect(crearRerankProvider('ninguno')).toBeNull();
  });

  it('avisa de un método inválido y de cohere sin clave, sin apagar chat ni embeddings', () => {
    process.env.RAG_RERANK_PROVIDER = 'cohere';
    expect(revisarConfiguracionIA().map((p) => p.variable)).toContain('COHERE_API_KEY');
    expect(chatDisponible().disponible).toBe(true);
    expect(embeddingsDisponibles().disponible).toBe(true);

    process.env.RAG_RERANK_PROVIDER = 'colbert';
    expect(revisarConfiguracionIA().map((p) => p.variable)).toContain('RAG_RERANK_PROVIDER');
    expect(chatDisponible().disponible).toBe(true);
  });
});
