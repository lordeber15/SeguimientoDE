import { test, expect, type Page } from '@playwright/test';
import { iniciarSesionSimulada, PERMISOS_TODOS } from './sesion';

/**
 * Modal de indexación por expediente, abierto desde el aviso amarillo del chat cuando un
 * expediente no está totalmente indexado (ChatPage.tsx → AvisoIngesta → ModalIndexacionExpediente).
 */

const ESTADO_INGESTA_INCOMPLETO = {
  total: 3, listos: 1, convertidos: 1, pendientes: 0, sinTexto: 0, error: 0, noSoportado: 1, completo: false,
};

const DOCUMENTOS_EXPEDIENTE = {
  total: 3,
  pagina: 1,
  porPagina: 50,
  items: [
    {
      id: 1, nuAnn: '2026', nuEmi: '0000001', nuAne: 0, titulo: 'PROVEIDO SIN ARCHIVO',
      tipoDoc: 'PROVEIDO', asunto: null, nuAnnExp: '2026', nuSecExp: '0000000062',
      numeroExpediente: 'DE000020260000062', estado: 'no_soportado', motivoError: 'sin bytes',
      intentos: 2, chars: null, chunksGenerados: null, metodo: null,
      estadoItem: null, motivoErrorItem: null,
    },
    {
      id: 2, nuAnn: '2026', nuEmi: '0000002', nuAne: 0, titulo: 'INFORME CONVERTIDO',
      tipoDoc: 'INFORME', asunto: null, nuAnnExp: '2026', nuSecExp: '0000000062',
      numeroExpediente: 'DE000020260000062', estado: 'convertido', motivoError: null,
      intentos: 0, chars: 1200, chunksGenerados: 2, metodo: 'markitdown',
      estadoItem: null, motivoErrorItem: null,
    },
    {
      id: 3, nuAnn: '2026', nuEmi: '0000003', nuAne: 0, titulo: 'OFICIO COMPLETO',
      tipoDoc: 'OFICIO', asunto: null, nuAnnExp: '2026', nuSecExp: '0000000062',
      numeroExpediente: 'DE000020260000062', estado: 'ok', motivoError: null,
      intentos: 0, chars: 800, chunksGenerados: 1, metodo: 'markitdown',
      estadoItem: null, motivoErrorItem: null,
    },
  ],
};

const PANEL_MINIMO = {
  corpus: {
    documentos: { total: 3, ok: 1, convertidos: 1, pendientes: 0, sinTexto: 0, error: 0, noSoportado: 1 },
    expedientes: { total: 1, completos: 0 },
    contenido: { unicos: 2, convertidos: 2, chunks: 3, caracteres: 2000 },
    embeddings: { vectores: 1, chunksSinEmbedding: 2 },
    cobertura: { conversionPct: 0.66, embeddingPct: 0.33 },
  },
  barrido: { activo: false, cadenciaMin: 15, cadenciaHashMin: 10080, ultimo: null, horasDesdeUltimo: null },
  proveedores: {
    embedding: { proveedor: 'ollama', disponible: true, motivo: null },
    chat: { proveedor: 'ollama' },
    vision: { proveedor: 'openai', disponible: false, motivo: 'OPENAI_API_KEY: falta configurar' },
    problemas: [],
    markitdown: { disponible: true, circuitoAbierto: false },
  },
  tokens: { hoy: [], acumulado: { tokensIn: 0, tokensOut: 0, costeUsd: 0 } },
  mantenimiento: {
    retencion: { activa: true, dias: 90, ultimo: null },
    gc: { activo: false, graciaDias: 7, ultimo: null, huerfanosPendientes: 0 },
  },
  evaluacion: { ventanaDias: 30, totalConsultas: 0, sinResultados: 0, conAlucinaciones: 0, escaneoExactoPct: 0, msPromedio: 0 },
  inventarioInicial: false,
};

/** Deja el chat con el expediente DE000020260000062 elegido, con ingesta incompleta. */
async function abrirChatConExpedienteIncompleto(page: Page, permisos: string[] = PERMISOS_TODOS) {
  await page.route('**/api/dependencias', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/rag/chat/expedientes/buscar**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { nuAnnExp: '2026', nuSecExp: '0000000062', numeroExpediente: 'DE000020260000062', documentos: 3, ingestados: 1 },
      ]),
    }),
  );
  await page.route('**/api/rag/chat/sesiones/expediente/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: 'null' }),
  );
  // Mismo endpoint que usan tanto el aviso del chat como el resumen del modal — una sola ruta.
  await page.route('**/api/rag/chat/expediente/*/*/estado', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ESTADO_INGESTA_INCOMPLETO) }),
  );
  await page.route('**/api/rag/panel', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PANEL_MINIMO) }),
  );

  await iniciarSesionSimulada(page, permisos);
  await page.goto('/');
  await page.getByRole('button', { name: 'Chat' }).click();
  await page.getByRole('tab', { name: 'Por expediente' }).click();

  await page.getByLabel('N° de expediente').fill('DE000020260000062');
  await page.getByRole('button', { name: 'Buscar' }).click();
  await expect(page.locator('.chat-expediente-elegido')).toContainText('DE000020260000062');
}

test.describe('Modal de indexación — permisos', () => {
  test('sin rag.gestionar, el aviso se ve pero no hay botón para corregir', async ({ page }) => {
    await abrirChatConExpedienteIncompleto(page, ['rag.consultar']);

    await expect(page.getByText(/1 de 3 documentos de este expediente/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ver y corregir indexación' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Documentos/ })).toHaveCount(0);
  });
});

test.describe('Modal de indexación — con rag.gestionar', () => {
  async function abrirModal(page: Page) {
    let pedidoDocumentos: URLSearchParams | null = null;
    await page.route('**/api/rag/documentos**', (route) => {
      pedidoDocumentos = new URL(route.request().url()).searchParams;
      return route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify(DOCUMENTOS_EXPEDIENTE),
      });
    });

    await abrirChatConExpedienteIncompleto(page);
    await page.getByRole('button', { name: 'Ver y corregir indexación' }).click();
    await expect(page.getByRole('dialog', { name: /Indexación del expediente/ })).toBeVisible();

    return () => pedidoDocumentos;
  }

  test('la lista de documentos se pide acotada al expediente, y "sin archivo" se ve como tal', async ({ page }) => {
    const leerPedido = await abrirModal(page);

    const pedido = leerPedido();
    expect(pedido?.get('nuAnnExp')).toBe('2026');
    expect(pedido?.get('nuSecExp')).toBe('0000000062');

    const filaSinArchivo = page.locator('tbody tr', { hasText: 'PROVEIDO SIN ARCHIVO' });
    await expect(filaSinArchivo.locator('.badge')).toHaveText('Sin archivo');
  });

  test('"Embeber este documento" en una fila convertida manda documentoIds, no el expediente entero', async ({ page }) => {
    await abrirModal(page);

    let cuerpoEnviado: unknown = null;
    await page.route('**/api/rag/ingesta/embeddings', (route) => {
      cuerpoEnviado = route.request().postDataJSON();
      return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ jobId: 55 }) });
    });
    await page.route('**/api/rag/ingesta/55', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 55, tipo: 'embedding', estado: 'completado', total: 2, procesados: 2, errores: 0,
          mensaje: null, feInicio: '2026-08-27T10:00:00.000Z', feFin: '2026-08-27T10:00:05.000Z',
        }),
      }),
    );

    const filaConvertida = page.locator('tbody tr', { hasText: 'INFORME CONVERTIDO' });
    await filaConvertida.getByRole('button', { name: 'Embeber este documento' }).click();

    await expect.poll(() => cuerpoEnviado).toEqual({ documentoIds: [2] });
    await expect(filaConvertida.getByText(/Trabajo #55 en curso/)).toBeVisible();
  });

  test('Escape cierra el modal', async ({ page }) => {
    await abrirModal(page);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: /Indexación del expediente/ })).toHaveCount(0);
  });
});
