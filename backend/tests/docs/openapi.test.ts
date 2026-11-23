import SwaggerParser from '@apidevtools/swagger-parser';
import request from 'supertest';
import type { Express } from 'express';
import type { OpenAPIV3 } from 'openapi-types';
import { construirDocumento } from '../../src/docs/openapi';

/**
 * Prefijos todavía sin documentar (docs/PLAN-SWAGGER.md §5). Cada fase quita los suyos; al
 * terminar la lista queda vacía y cualquier ruta nueva sin documentar rompe este test.
 */
const PENDIENTES = [
  '/api/admin',
  '/api/rag',
  '/api/dashboard',
  '/api/calidad-procesos',
  '/api/dependencias',
  '/api/seguimiento',
  '/api/documentos',
  '/api/unir-pdf',
  '/api/std',
];

const METODOS = ['get', 'post', 'put', 'patch', 'delete'] as const;

function cargarApp(swagger: boolean): Express {
  const anterior = process.env.SWAGGER_HABILITADO;
  if (swagger) process.env.SWAGGER_HABILITADO = 'true';
  else delete process.env.SWAGGER_HABILITADO;
  let mod: { default: Express };
  jest.isolateModules(() => {
    mod = require('../../src/app');
  });
  if (anterior === undefined) delete process.env.SWAGGER_HABILITADO;
  else process.env.SWAGGER_HABILITADO = anterior;
  return mod!.default;
}

/** `/^\/api\/auth\/?(?=\/|$)/i` → `/api/auth`. Formato de las capas de `app.use` en Express 4. */
function prefijoDeCapa(capa: { regexp: RegExp & { fast_slash?: boolean } }): string {
  if (capa.regexp.fast_slash) return '';
  return capa.regexp.source
    .replace(/^\^/, '')
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
    .replace(/\\\//g, '/');
}

/** Rutas reales de la app como `"get /api/auth/login"`, con parámetros al estilo OpenAPI (`{id}`). */
function rutasReales(app: Express): string[] {
  const rutas: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recorrer = (pila: any[], prefijo: string) => {
    for (const capa of pila) {
      if (capa.route) {
        const ruta = (prefijo + (capa.route.path === '/' ? '' : capa.route.path)) || '/';
        const openapi = ruta.replace(/:(\w+)/g, '{$1}');
        for (const metodo of Object.keys(capa.route.methods)) rutas.push(`${metodo} ${openapi}`);
      } else if (capa.handle?.stack) {
        recorrer(capa.handle.stack, prefijo + prefijoDeCapa(capa));
      }
    }
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  recorrer((app as any)._router.stack, '');
  return rutas;
}

function rutasDocumentadas(doc: OpenAPIV3.Document): string[] {
  return Object.entries(doc.paths).flatMap(([ruta, item]) =>
    METODOS.filter((m) => item?.[m]).map((m) => `${m} ${ruta}`),
  );
}

function operaciones(doc: OpenAPIV3.Document) {
  return Object.entries(doc.paths).flatMap(([ruta, item]) =>
    METODOS.filter((m) => item?.[m]).map((m) => ({
      id: `${m} ${ruta}`,
      op: item![m] as OpenAPIV3.OperationObject & { 'x-uso'?: string; 'x-permiso'?: string },
    })),
  );
}

describe('documentación OpenAPI', () => {
  const doc = construirDocumento();

  it('es un documento OpenAPI 3.0 válido', async () => {
    // validate() muta el objeto al resolver $ref: se le pasa una copia.
    await expect(SwaggerParser.validate(structuredClone(doc) as never)).resolves.toBeDefined();
  });

  it('no documenta rutas que no existen', () => {
    const reales = new Set(rutasReales(cargarApp(false)));
    const fantasmas = rutasDocumentadas(doc).filter((r) => !reales.has(r));
    expect(fantasmas).toEqual([]);
  });

  it('documenta todas las rutas, salvo los prefijos pendientes', () => {
    const documentadas = new Set(rutasDocumentadas(doc));
    const sinDocumentar = rutasReales(cargarApp(false)).filter((r) => {
      const ruta = r.split(' ')[1];
      const pendiente = PENDIENTES.some((p) => ruta === p || ruta.startsWith(`${p}/`));
      return !pendiente && !documentadas.has(r);
    });
    expect(sinDocumentar).toEqual([]);
  });

  it('cada operación está clasificada como integración o interna, con su tag', () => {
    for (const { id, op } of operaciones(doc)) {
      expect({ id, uso: op['x-uso'] }).toEqual({ id, uso: expect.stringMatching(/^(integracion|interno)$/) });
      const prefijo = op['x-uso'] === 'integracion' ? '[Integración]' : '[Interno]';
      expect({ id, tags: op.tags }).toEqual({ id, tags: [expect.stringContaining(prefijo)] });
    }
  });

  it('cada operación tiene descripción en español y respuestas de error', () => {
    for (const { id, op } of operaciones(doc)) {
      expect({ id, summary: Boolean(op.summary) }).toEqual({ id, summary: true });
      const codigos = Object.keys(op.responses);
      const publica = Array.isArray(op.security) && op.security.length === 0;
      if (!publica) expect({ id, codigos }).toEqual({ id, codigos: expect.arrayContaining(['401', '500']) });
    }
  });

  describe('montaje', () => {
    it('sin SWAGGER_HABILITADO, /api/docs no existe', async () => {
      const app = cargarApp(false);
      expect((await request(app).get('/api/docs/openapi.json')).status).toBe(404);
      expect((await request(app).get('/api/docs/')).status).toBe(404);
    });

    it('con SWAGGER_HABILITADO=true, sirve la UI y el contrato', async () => {
      const app = cargarApp(true);

      const json = await request(app).get('/api/docs/openapi.json');
      expect(json.status).toBe(200);
      expect(json.body.openapi).toBe('3.0.3');
      expect(json.body.paths['/api/auth/login']).toBeDefined();

      const ui = await request(app).get('/api/docs/');
      expect(ui.status).toBe(200);
      expect(ui.text).toContain('swagger-ui');
    });
  });
});
