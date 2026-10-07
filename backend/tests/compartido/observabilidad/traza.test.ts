/**
 * Trazas del chat (docs/PLAN-RAG-AVANZADO.md, Fase 2): contexto implícito con AsyncLocalStorage. Lo
 * que importa garantizar es que fuera de una traza todo sea un no-op (ingesta, scripts, eval:rag no
 * deben cambiar), que los pasos en paralelo queden bajo su padre correcto, y que publicar nunca
 * demore ni tumbe la respuesta.
 */

import {
  acotar,
  conReintentos,
  enTraza,
  evento,
  paso,
  registrarPublicador,
  reintentosDelContexto,
  trazaActual,
  type Traza,
} from '../../../src/compartido/observabilidad/traza';
import { aOtlp } from '../../../src/compartido/observabilidad/publicacion';

const db = {} as never;
const datos = { nombre: 'chat.sgd.general', modulo: 'sgd' as const, db, usuarioId: 'u1' };

afterEach(() => registrarPublicador(null));

describe('fuera de una traza', () => {
  it('paso, evento y trazaActual son no-op: solo se ejecuta la función', async () => {
    expect(trazaActual()).toBeUndefined();
    await expect(paso('x', null, async () => 7)).resolves.toBe(7);
    expect(() => evento('y')).not.toThrow();
  });
});

describe('enTraza', () => {
  it('anida los pasos bajo su padre, también los lanzados en paralelo', async () => {
    let traza!: Traza;
    await enTraza(datos, async (t) => {
      traza = t;
      await paso('padre', null, async () => {
        await Promise.all([
          paso('hijo-a', null, async () => { evento('dentro-a'); }),
          paso('hijo-b', null, async () => undefined),
        ]);
      });
    });

    const porNombre = Object.fromEntries(traza.pasos.map((p) => [p.nombre, p]));
    expect(porNombre.padre.padreId).toBe(traza.raizId);
    expect(porNombre['hijo-a'].padreId).toBe(porNombre.padre.id);
    expect(porNombre['hijo-b'].padreId).toBe(porNombre.padre.id);
    expect(porNombre['dentro-a'].padreId).toBe(porNombre['hijo-a'].id);
    expect(traza.estado).toBe('ok');
    expect(traza.id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('un paso que falla queda ERROR con su mensaje y la traza en error; el error se propaga', async () => {
    let traza!: Traza;
    await expect(enTraza(datos, async (t) => {
      traza = t;
      await paso('respuesta', null, async () => { throw new Error('caído'); });
    })).rejects.toThrow('caído');

    expect(traza.pasos[0]).toMatchObject({ nombre: 'respuesta', nivel: 'ERROR', error: 'caído' });
    expect(traza).toMatchObject({ estado: 'error', error: 'caído' });
  });

  it('suma los tokens de los pasos y usa `resumir` para la salida, sin guardar el resultado entero', async () => {
    let traza!: Traza;
    await enTraza(datos, async (t) => {
      traza = t;
      await paso('llm', { prompt: 'p' }, async () => ({ texto: 'r', secreto: 'x'.repeat(10) }), {
        tipo: 'generacion',
        resumir: (r) => ({ salida: r.texto, tokensIn: 10, tokensOut: 3, modelo: 'm' }),
      });
      await paso('llm2', null, async () => null, { resumir: () => ({ tokensIn: 5 }) });
    });

    expect(traza.tokensIn).toBe(15);
    expect(traza.tokensOut).toBe(3);
    expect(traza.pasos[0]).toMatchObject({ tipo: 'generacion', salida: 'r', modelo: 'm' });
  });

  it('publica al terminar sin esperar al publicador, y un publicador que falla no rompe nada', async () => {
    let liberar!: () => void;
    const publicado = new Promise<void>((r) => { liberar = r; });
    registrarPublicador(() => publicado.then(() => { throw new Error('BD caída'); }));
    const avisar = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(enTraza(datos, async () => 'listo')).resolves.toBe('listo'); // no esperó a `publicado`
    liberar();
    await new Promise((r) => setImmediate(r));

    expect(avisar).toHaveBeenCalledWith(expect.stringContaining('BD caída'));
    avisar.mockRestore();
  });

  it('continuar una traza (reintento) conserva el id y abre otro raíz', async () => {
    let t!: Traza;
    await enTraza({ ...datos, id: 'f'.repeat(32) }, async (x) => { t = x; });
    expect(t.id).toBe('f'.repeat(32));
    expect(t.continuacion).toBe(true);
  });
});

describe('conReintentos', () => {
  it('fija los reintentos del contexto para lo anidado, dentro y fuera de una traza', async () => {
    expect(reintentosDelContexto()).toBeUndefined();
    await conReintentos(1, async () => expect(reintentosDelContexto()).toBe(1));
    await enTraza(datos, () => conReintentos(3, async () => expect(reintentosDelContexto()).toBe(3)));
  });
});

describe('acotar', () => {
  it('recorta textos y objetos grandes y deja intactos los pequeños', () => {
    expect(acotar('abc')).toBe('abc');
    expect(acotar('x'.repeat(50), 10)).toBe(`${'x'.repeat(10)}…[+40]`);
    expect(acotar({ a: 1 })).toEqual({ a: 1 });
    expect(acotar({ t: 'x'.repeat(50) }, 10)).toMatchObject({ recortado: true });
  });
});

describe('aOtlp (Langfuse)', () => {
  it('arma spans OTLP con contexto de la traza, tipo de observación, modelo, tokens y errores', async () => {
    let traza!: Traza;
    await enTraza({ ...datos, sesionId: 42 }, async (t) => {
      traza = t;
      t.mensajeId = 99;
      await paso('llm openai/gpt', 'hola', async () => 1, {
        tipo: 'generacion', resumir: () => ({ modelo: 'gpt-4o-mini', tokensIn: 12, tokensOut: 4 }),
      });
      await paso('retrieval', null, async () => { throw new Error('sin BD'); }, { tipo: 'recuperacion' }).catch(() => undefined);
    });

    const cuerpo = aOtlp(traza) as { resourceSpans: { scopeSpans: { spans: Record<string, unknown>[] }[] }[] };
    const spans = cuerpo.resourceSpans[0].scopeSpans[0].spans;
    const attrs = (s: Record<string, unknown>) => Object.fromEntries(
      (s.attributes as { key: string; value: Record<string, unknown> }[]).map((a) => [a.key, Object.values(a.value)[0]]),
    );

    expect(spans).toHaveLength(3); // raíz + 2 pasos
    const [raiz, gen, ret] = spans;
    expect(raiz.parentSpanId).toBeUndefined();
    expect(gen.parentSpanId).toBe(raiz.spanId);
    expect(gen.traceId).toBe(traza.id);
    expect(attrs(gen)).toMatchObject({
      'langfuse.observation.type': 'generation',
      'gen_ai.request.model': 'gpt-4o-mini',
      'gen_ai.usage.input_tokens': '12',
      'langfuse.user.id': 'u1',
      'langfuse.session.id': 'sgd-42',
      'langfuse.trace.metadata.mensaje_id': '99',
    });
    expect(attrs(ret)).toMatchObject({ 'langfuse.observation.type': 'retriever', 'langfuse.observation.level': 'ERROR' });
    expect(ret.status).toEqual({ code: 2, message: 'sin BD' });
    expect(BigInt(gen.endTimeUnixNano as string) >= BigInt(gen.startTimeUnixNano as string)).toBe(true);
  });
});
