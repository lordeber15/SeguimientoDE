import { test, expect, type Page } from '@playwright/test';
import { iniciarSesionSimulada } from './sesion';

const PANEL_BASE = {
  corpus: {
    documentos: { total: 5708, ok: 0, convertidos: 13, pendientes: 5688, sinTexto: 0, error: 0, noSoportado: 7 },
    expedientes: { total: 1043, completos: 0 },
    contenido: { unicos: 13, convertidos: 13, chunks: 119, caracteres: 186773 },
    embeddings: { vectores: 0, chunksSinEmbedding: 119 },
    cobertura: { conversionPct: 0.2, embeddingPct: 0 },
  },
  barrido: {
    activo: false,
    cadenciaMin: 15,
    cadenciaHashMin: 10080,
    ultimo: {
      id: 5, tipo: 'inventario_inicial', disparo: 'manual',
      feInicio: '2026-08-23T20:01:52.000Z', feFin: '2026-08-23T20:01:57.000Z',
      expedientesRevisados: 1043, documentosNuevos: 5708, documentosCambiados: 0, documentosBaja: 0,
      error: null,
    },
    horasDesdeUltimo: 0.1,
  },
  proveedores: {
    embedding: { proveedor: 'ollama', disponible: true, motivo: null },
    chat: { proveedor: 'ollama' },
    // Sin clave por defecto: refleja el estado real del `.env` (comentada) y ejercita el camino
    // "deshabilitado con motivo" en vez de esconder ese caso en todos los tests existentes.
    vision: { proveedor: 'openai', disponible: false, motivo: 'OPENAI_API_KEY: falta configurar' },
    problemas: [],
    markitdown: { disponible: true, circuitoAbierto: false },
  },
  tokens: { hoy: [], acumulado: { tokensIn: 0, tokensOut: 0, costeUsd: 0 } },
  // `PanelRag` los exige (Fase 6) — sin ellos la página revienta al leer `panel.mantenimiento.retencion`.
  mantenimiento: {
    retencion: { activa: true, dias: 90, ultimo: null },
    gc: { activo: false, graciaDias: 7, ultimo: null, huerfanosPendientes: 0 },
  },
  evaluacion: {
    ventanaDias: 30, totalConsultas: 0, sinResultados: 0, conAlucinaciones: 0,
    escaneoExactoPct: 0, msPromedio: 0,
  },
  inventarioInicial: false,
};

const DOCUMENTOS_VACIOS = { total: 0, pagina: 1, porPagina: 50, items: [] };

async function abrirPanel(page: Page, panel: unknown = PANEL_BASE, documentos: unknown = DOCUMENTOS_VACIOS) {
  // La vista por defecto es "Seguimiento" y pide /api/dependencias al montar. Sin simularla, la
  // petición cae en el backend real, que responde 401 al token falso de la prueba y cierra la
  // sesión antes de poder pulsar la pestaña RAG.
  await page.route('**/api/dependencias', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/rag/panel', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(panel) }),
  );
  // La lista de documentos individuales pide su propio endpoint al montar — sin mock cae en el
  // backend real con el token falso, y el mismo 401 global cierra la sesión (igual que
  // /api/dependencias arriba). Solo responde al GET: un test que registre después una ruta más
  // específica para el POST de "reintentar" sobre el mismo patrón `**/api/rag/documentos**` no
  // necesita preocuparse del orden de registro.
  await page.route('**/api/rag/documentos**', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(documentos) });
  });
  await iniciarSesionSimulada(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'RAG' }).click();
}

test.describe('Panel RAG — con API simulada', () => {
  test('muestra la cobertura y el estado del barrido', async ({ page }) => {
    await abrirPanel(page);

    await expect(page.getByRole('heading', { name: 'Base de conocimientos' })).toBeVisible();
    await expect(page.getByText('5708').first()).toBeVisible();
    await expect(page.getByText(/13.*nuevo/)).toHaveCount(0); // no confundir con otro contador
    await expect(page.getByText(/5708 nuevo/)).toBeVisible();

    const interruptor = page.getByRole('checkbox', { name: 'Automático' });
    await expect(interruptor).not.toBeChecked();
  });

  test('activar el interruptor llama a la API y refresca', async ({ page }) => {
    await abrirPanel(page);

    let cuerpoEnviado: unknown = null;
    await page.route('**/api/rag/config/rag.barrido.activo', (route) => {
      cuerpoEnviado = route.request().postDataJSON();
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    });
    // El panel se vuelve a pedir tras guardar: si siguiera devolviendo activo:false, la casilla
    // rebotaría a su estado anterior en cuanto llegara la respuesta.
    await page.route('**/api/rag/panel', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...PANEL_BASE, barrido: { ...PANEL_BASE.barrido, activo: true } }),
      }),
    );

    // .click() en vez de .check(): la casilla es un componente controlado por el panel, que solo
    // cambia tras el viaje de ida y vuelta al servidor — el propio .check() de Playwright espera
    // que el estado cambie de inmediato al clic y lo interpreta como "no cambió".
    await page.getByRole('checkbox', { name: 'Automático' }).click();
    await expect(page.getByText('Barrido activado.')).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Automático' })).toBeChecked();
    expect(cuerpoEnviado).toEqual({ valor: true });
  });

  test('"Barrer ahora" funciona aunque el interruptor esté apagado', async ({ page }) => {
    await abrirPanel(page); // barrido.activo: false en la base

    await page.route('**/api/rag/barrer', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 6, documentosNuevos: 2, documentosBaja: 0 }),
      }),
    );

    await page.getByRole('button', { name: 'Barrer ahora' }).click();
    await expect(page.getByText(/2 nuevo\(s\)/)).toBeVisible();
  });

  test('"Generar embeddings" deshabilitado cuando el proveedor no está configurado', async ({ page }) => {
    await abrirPanel(page, {
      ...PANEL_BASE,
      proveedores: {
        ...PANEL_BASE.proveedores,
        embedding: { proveedor: 'openai', disponible: false, motivo: 'OPENAI_API_KEY: falta configurar' },
      },
    });

    const boton = page.getByRole('button', { name: 'Generar embeddings' });
    await expect(boton).toBeDisabled();
    await expect(page.getByText(/Bloqueado: OPENAI_API_KEY/)).toBeVisible();
  });

  test('"Convertir documentos pendientes" funciona sin proveedor de IA configurado', async ({ page }) => {
    // El punto central de la Fase 3 sin API keys: la conversión no depende de ningún proveedor.
    await abrirPanel(page, {
      ...PANEL_BASE,
      proveedores: {
        ...PANEL_BASE.proveedores,
        embedding: { proveedor: 'openai', disponible: false, motivo: 'falta configurar' },
      },
    });

    const botonConvertir = page.getByRole('button', { name: 'Convertir documentos pendientes' });
    await expect(botonConvertir).toBeEnabled();

    await page.route('**/api/rag/ingesta/conversion', (route) =>
      route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ jobId: 9 }) }),
    );
    await page.route('**/api/rag/ingesta/9', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 9, tipo: 'conversion', estado: 'en_curso', total: 500, procesados: 12, errores: 0,
          mensaje: null, feInicio: '2026-08-23T20:10:00.000Z', feFin: null,
        }),
      }),
    );

    await botonConvertir.click();
    await expect(page.getByText(/Trabajo #9 \(conversion\)/)).toBeVisible();
    await expect(page.getByText('12/500')).toBeVisible();
  });

  test('un job de embeddings bloqueado muestra el motivo, no un error genérico', async ({ page }) => {
    await abrirPanel(page);

    await page.route('**/api/rag/ingesta/embeddings', (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          message: 'No se puede iniciar la ingesta de embeddings: OLLAMA_URL no responde',
        }),
      }),
    );

    await page.getByRole('button', { name: 'Generar embeddings' }).click();
    await expect(page.getByText(/OLLAMA_URL no responde/)).toBeVisible();
  });

  test('al iniciar una conversión, la lista de documentos se filtra sola al trabajo', async ({ page }) => {
    // Responde a la pregunta real detrás de "Trabajo #23 — 373/500": a qué archivos se refiere.
    await abrirPanel(page);

    await page.route('**/api/rag/ingesta/conversion', (route) =>
      route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ jobId: 9 }) }),
    );
    await page.route('**/api/rag/ingesta/9', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 9, tipo: 'conversion', estado: 'en_curso', total: 500, procesados: 12, errores: 1,
          mensaje: null, feInicio: '2026-08-23T20:10:00.000Z', feFin: null,
        }),
      }),
    );

    // Un único handler para ambas variantes de /api/rag/documentos: con jobId=9 (lo que dispara
    // el filtro automático al arrancar el trabajo) y sin él (el montaje inicial de la lista).
    await page.route('**/api/rag/documentos**', (route) => {
      const jobId = new URL(route.request().url()).searchParams.get('jobId');
      if (jobId !== '9') {
        return route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ total: 0, pagina: 1, porPagina: 50, items: [] }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          total: 2,
          pagina: 1,
          porPagina: 50,
          items: [
            {
              id: 1, nuAnn: '2026', nuEmi: '0000001', nuAne: 0, titulo: 'PROVEIDO N° 000118-2026-DE',
              tipoDoc: 'PROVEIDO', asunto: 'Asunto de prueba', nuAnnExp: '2026', nuSecExp: '0000000303',
              numeroExpediente: 'PMESTPOMSE20260000003', estado: 'convertido', motivoError: null,
              intentos: 7, chars: 1722, chunksGenerados: 1, metodo: 'markitdown',
              // El caso real que estaba invisible: el documento terminó bien, pero ESTE trabajo
              // tuvo un fallo transitorio de markitdown al procesarlo.
              estadoItem: 'error', motivoErrorItem: 'markitdown no responde; reintento en 59 s',
            },
          ],
        }),
      });
    });

    await page.getByRole('button', { name: 'Convertir documentos pendientes' }).click();
    await expect(page.getByText(/Trabajo #9 \(conversion\)/)).toBeVisible();

    // Se filtra solo, sin que haga falta pulsar nada más.
    await expect(page.getByText('Mostrando solo los documentos del trabajo #9 (2).')).toBeVisible();
    await expect(page.getByText('PROVEIDO N° 000118-2026-DE')).toBeVisible();
    await expect(page.getByText('PMESTPOMSE20260000003')).toBeVisible();
    await expect(page.getByText(/en este trabajo: markitdown no responde/)).toBeVisible();

    await page.getByRole('button', { name: 'Ver todos los documentos' }).click();
    await expect(page.getByText(/Mostrando solo los documentos del trabajo/)).toHaveCount(0);
  });

  test('"Reparar recuperables" inicia un trabajo de reparación, nunca de conversión ni embeddings', async ({ page }) => {
    await abrirPanel(page, {
      ...PANEL_BASE,
      corpus: { ...PANEL_BASE.corpus, documentos: { ...PANEL_BASE.corpus.documentos, noSoportado: 5, sinTexto: 2 } },
    });

    await page.route('**/api/rag/ingesta/reparacion', (route) =>
      route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ jobId: 30 }) }),
    );
    await page.route('**/api/rag/ingesta/30', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 30, tipo: 'reparacion', estado: 'en_curso', total: 7, procesados: 3, errores: 0,
          mensaje: null, feInicio: '2026-08-26T10:00:00.000Z', feFin: null,
        }),
      }),
    );

    const boton = page.getByRole('button', { name: 'Reparar recuperables' });
    await expect(boton).toBeEnabled();
    await boton.click();

    await expect(page.getByText(/Trabajo #30 \(reparacion\)/)).toBeVisible();
    await expect(page.getByText('Mostrando solo los documentos del trabajo #30')).toBeVisible();
  });

  test('"Reparar recuperables" está deshabilitado cuando no hay nada recuperable', async ({ page }) => {
    await abrirPanel(page, {
      ...PANEL_BASE,
      corpus: { ...PANEL_BASE.corpus, documentos: { ...PANEL_BASE.corpus.documentos, noSoportado: 0, sinTexto: 0 } },
    });

    await expect(page.getByRole('button', { name: 'Reparar recuperables' })).toBeDisabled();
  });

  test('"Reintentar" actualiza la fila en su sitio — no desaparece bajo el filtro por defecto', async ({ page }) => {
    const documentoInicial = {
      id: 42, nuAnn: '2026', nuEmi: '0000000042', nuAne: 0, titulo: 'PROVEIDO N° 1',
      tipoDoc: 'PROVEIDO', asunto: null, nuAnnExp: '2026', nuSecExp: '0000000001',
      numeroExpediente: 'EXP-1', estado: 'sin_texto', motivoError: null, intentos: 2,
      chars: 50, chunksGenerados: 0, metodo: 'markitdown', estadoItem: null, motivoErrorItem: null,
    };

    // La lista abre filtrada a "Sin texto" por defecto: el documento debe calzar en ese filtro
    // para que este test compruebe lo que de verdad importa (que NO se recarga tras el éxito).
    await abrirPanel(page, PANEL_BASE, { total: 1, pagina: 1, porPagina: 50, items: [documentoInicial] });

    await expect(page.getByText('PROVEIDO N° 1')).toBeVisible();

    await page.route('**/api/rag/documentos/42/reintentar', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          documento: { ...documentoInicial, estado: 'convertido', chars: 500, chunksGenerados: 1 },
        }),
      }),
    );

    await page.getByRole('button', { name: 'Reintentar' }).click();

    // Sigue visible aunque ya no encaje en el filtro "Sin texto": no hubo un refetch que la
    // escondiera justo al tener éxito.
    await expect(page.getByText('PROVEIDO N° 1')).toBeVisible();
    await expect(page.locator('tbody tr', { hasText: 'PROVEIDO N° 1' }).locator('.badge')).toHaveText('Convertido');
    await expect(page.getByText('Convertido — 500 caracteres, 1 fragmento(s).')).toBeVisible();
  });

  test('"Reintentar" muestra el motivo del backend cuando falla, en la propia fila', async ({ page }) => {
    const documentoInicial = {
      id: 42, nuAnn: '2026', nuEmi: '0000000042', nuAne: 0, titulo: 'PROVEIDO N° 1',
      tipoDoc: 'PROVEIDO', asunto: null, nuAnnExp: '2026', nuSecExp: '0000000001',
      numeroExpediente: 'EXP-1', estado: 'sin_texto', motivoError: null, intentos: 2,
      chars: 50, chunksGenerados: 0, metodo: 'markitdown', estadoItem: null, motivoErrorItem: null,
    };
    await abrirPanel(page, PANEL_BASE, { total: 1, pagina: 1, porPagina: 50, items: [documentoInicial] });

    await page.route('**/api/rag/documentos/42/reintentar', (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Este documento está en la cola del trabajo #7; espere a que termine' }),
      }),
    );

    await page.getByRole('button', { name: 'Reintentar' }).click();

    await expect(page.getByText(/en la cola del trabajo #7/)).toBeVisible();
  });

  test('"Extraer con ChatGPT" solo aparece en sin_texto/error — nunca en sin_archivo ni convertido', async ({ page }) => {
    const base = {
      nuAnn: '2026', nuEmi: '0000000042', nuAne: 0, tipoDoc: 'PROVEIDO', asunto: null,
      nuAnnExp: '2026', nuSecExp: '0000000001', numeroExpediente: 'EXP-1', motivoError: null,
      intentos: 2, chars: 50, chunksGenerados: 0, metodo: 'markitdown', estadoItem: null, motivoErrorItem: null,
    };
    const items = [
      { ...base, id: 1, titulo: 'Doc sin texto', estado: 'sin_texto' },
      { ...base, id: 2, titulo: 'Doc con error', estado: 'error' },
      { ...base, id: 3, titulo: 'Doc sin archivo', estado: 'no_soportado' },
      { ...base, id: 4, titulo: 'Doc convertido', estado: 'convertido' },
    ];
    // El mock devuelve los 4 sin filtrar server-side, así que ya se ven con el filtro por
    // defecto ("Sin texto") sin tocar nada más.
    await abrirPanel(page, PANEL_BASE, { total: items.length, pagina: 1, porPagina: 50, items });
    await expect(page.getByText('Doc sin texto')).toBeVisible();

    // `toHaveCount` reintenta hasta que la tabla termine de renderizar; `.count()` suelto no
    // espera nada y puede leer el DOM a mitad de un render.
    const botonVision = (titulo: string) =>
      page.locator('tbody tr', { hasText: titulo }).getByRole('button', { name: /Extraer con ChatGPT/ });

    await expect(botonVision('Doc sin texto')).toHaveCount(1);
    await expect(botonVision('Doc con error')).toHaveCount(1);
    await expect(botonVision('Doc sin archivo')).toHaveCount(0);
    await expect(botonVision('Doc convertido')).toHaveCount(0);
  });

  test('"Extraer con ChatGPT" está deshabilitado con el motivo cuando falta la clave', async ({ page }) => {
    const documentoInicial = {
      id: 42, nuAnn: '2026', nuEmi: '0000000042', nuAne: 0, titulo: 'PROVEIDO N° 1',
      tipoDoc: 'PROVEIDO', asunto: null, nuAnnExp: '2026', nuSecExp: '0000000001',
      numeroExpediente: 'EXP-1', estado: 'sin_texto', motivoError: null, intentos: 2,
      chars: 50, chunksGenerados: 0, metodo: 'markitdown', estadoItem: null, motivoErrorItem: null,
    };
    // PANEL_BASE ya trae vision.disponible: false, reflejando que la clave no está puesta.
    await abrirPanel(page, PANEL_BASE, { total: 1, pagina: 1, porPagina: 50, items: [documentoInicial] });

    const boton = page.getByRole('button', { name: 'Extraer con ChatGPT' });
    await expect(boton).toBeDisabled();
    await expect(boton).toHaveAttribute('title', 'OPENAI_API_KEY: falta configurar');
  });

  test('"Extraer con ChatGPT" con clave disponible extrae y actualiza la fila sin recargar', async ({ page }) => {
    const documentoInicial = {
      id: 42, nuAnn: '2026', nuEmi: '0000000042', nuAne: 0, titulo: 'PROVEIDO N° 1',
      tipoDoc: 'PROVEIDO', asunto: null, nuAnnExp: '2026', nuSecExp: '0000000001',
      numeroExpediente: 'EXP-1', estado: 'sin_texto', motivoError: null, intentos: 2,
      chars: 50, chunksGenerados: 0, metodo: 'markitdown', estadoItem: null, motivoErrorItem: null,
    };
    await abrirPanel(
      page,
      { ...PANEL_BASE, proveedores: { ...PANEL_BASE.proveedores, vision: { proveedor: 'openai', disponible: true, motivo: null } } },
      { total: 1, pagina: 1, porPagina: 50, items: [documentoInicial] },
    );

    const boton = page.getByRole('button', { name: 'Extraer con ChatGPT' });
    await expect(boton).toBeEnabled();

    await page.route('**/api/rag/documentos/42/vision', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          documento: { ...documentoInicial, estado: 'convertido', chars: 900, chunksGenerados: 2, metodo: 'vision' },
        }),
      }),
    );

    await boton.click();

    // Sigue visible aunque ya no encaje en el filtro "Sin texto": tampoco aquí hubo recarga.
    await expect(page.getByText('PROVEIDO N° 1')).toBeVisible();
    await expect(page.locator('tbody tr', { hasText: 'PROVEIDO N° 1' }).locator('.badge')).toHaveText('Convertido');
    await expect(page.getByText('Extraído con IA — 900 caracteres, 2 fragmento(s).')).toBeVisible();
  });

  test('lista los problemas de configuración de IA cuando los hay', async ({ page }) => {
    await abrirPanel(page, {
      ...PANEL_BASE,
      proveedores: {
        ...PANEL_BASE.proveedores,
        problemas: [{ variable: 'ANTHROPIC_API_KEY', mensaje: 'Necesaria para usar Anthropic como proveedor de chat.' }],
      },
    });

    await expect(page.getByText('ANTHROPIC_API_KEY')).toBeVisible();
    await expect(page.getByText(/Necesaria para usar Anthropic/)).toBeVisible();
  });
});
