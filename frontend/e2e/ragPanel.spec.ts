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
    mineru: { disponible: true, circuitoAbierto: false },
    conversion: { proveedorActivo: 'markitdown', proveedorRespaldo: 'mineru' },
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
  // La lista de trabajos: la piden al montar TANTO `SeguimientoPage` (la vista inicial) como el
  // panel RAG, para reengancharse a un job que siguiera corriendo. Sin simularla cae en el backend
  // real —que con el token falso responde 401— y el manejador global cierra la sesión: la app se va
  // al login y la pestaña RAG se desmonta antes de poder pulsarla. Por defecto, ningún job vivo.
  await page.route('**/api/rag/ingesta', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
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

  test('"Barrer ahora" muestra un estado de carga mientras el barrido está en curso', async ({ page }) => {
    await abrirPanel(page);

    await page.route('**/api/rag/barrer', async (route) => {
      await new Promise((r) => setTimeout(r, 1000));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 6, documentosNuevos: 3, documentosBaja: 1 }),
      });
    });

    const boton = page.getByRole('button', { name: /Barrer ahora|Barriendo/ });
    await boton.click();

    await expect(page.getByRole('button', { name: 'Barriendo…' })).toBeDisabled();
    await expect(page.getByText('Barrido en curso… puede tardar unos minutos.')).toBeVisible();

    await expect(page.getByText(/3 nuevo\(s\), 1 baja\(s\)/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Barrer ahora' })).toBeEnabled();
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

  /**
   * La barra secundaria de fases (uno de los conversores está haciendo el trabajo de verdad) —
   * ver `PanelJobIngesta.tsx`. `page.route` con un `fulfill` estático responde EXACTAMENTE lo
   * mismo en cada sondeo (cada 1500 ms): la fecha/segundos que se ven crecer entre respuestas
   * salen del reloj local del navegador, no de datos nuevos del servidor.
   */
  async function lanzarConversionConProceso(page: Page, procesoActual: Record<string, unknown>) {
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
          procesoActual,
        }),
      }),
    );
    await page.getByRole('button', { name: 'Convertir documentos pendientes' }).click();
  }

  test('la fase "convirtiendo" nombra el conversor y el tope, y la barra queda dentro de su tramo', async ({ page }) => {
    await abrirPanel(page);
    await lanzarConversionConProceso(page, {
      documentoId: 100, titulo: 'INFORME GRANDE', segundos: 30,
      fase: 'convirtiendo', faseMs: 30000, faseLimiteMs: 195000,
      proveedor: 'markitdown', intento: 1, intentos: 1, motivoFallback: null,
    });

    await expect(page.getByText(/Convirtiendo con markitdown/)).toBeVisible();
    await expect(page.getByText(/30 s de máx\. 195 s/)).toBeVisible();

    const relleno = page.locator('.rag-job-actual .barra-progreso--documento .barra-progreso-relleno');
    const ancho = await relleno.evaluate((el) => parseFloat((el as HTMLElement).style.width));
    // Tramo de "convirtiendo" sin respaldo: [15, 85].
    expect(ancho).toBeGreaterThan(15);
    expect(ancho).toBeLessThan(85);
  });

  test('la barra del documento avanza entre sondeos por el reloj local, no solo al recibir datos', async ({ page }) => {
    await abrirPanel(page);
    // `faseMs` se queda fijo en cada respuesta simulada — si el ancho creciera igual, sería por
    // el `setInterval` de 500 ms del propio panel (`useDesdeUltimoDato`), no por el servidor.
    await lanzarConversionConProceso(page, {
      documentoId: 100, titulo: 'INFORME GRANDE', segundos: 30,
      fase: 'convirtiendo', faseMs: 5000, faseLimiteMs: 195000,
      proveedor: 'markitdown', intento: 1, intentos: 1, motivoFallback: null,
    });

    const relleno = page.locator('.rag-job-actual .barra-progreso--documento .barra-progreso-relleno');
    await expect(relleno).toBeVisible();
    const anchoInicial = await relleno.evaluate((el) => parseFloat((el as HTMLElement).style.width));

    await expect
      .poll(() => relleno.evaluate((el) => parseFloat((el as HTMLElement).style.width)), { timeout: 5000 })
      .toBeGreaterThan(anchoInicial);
  });

  test('el salto al respaldo se ve como un salto y explica por qué falló el primero', async ({ page }) => {
    await abrirPanel(page);
    await lanzarConversionConProceso(page, {
      documentoId: 101, titulo: 'OFICIO PESADO', segundos: 220,
      fase: 'convirtiendo', faseMs: 40000, faseLimiteMs: 315000,
      proveedor: 'mineru', intento: 2, intentos: 2,
      motivoFallback: 'markitdown: La conversión superó 180 s',
    });

    await expect(page.getByText(/intento 2 de 2 · respaldo/)).toBeVisible();
    await expect(page.getByText('markitdown: La conversión superó 180 s')).toBeVisible();

    // Con respaldo, el tramo [15,85] se reparte en dos: el segundo intento arranca en su mitad (50).
    const relleno = page.locator('.rag-job-actual .barra-progreso--documento .barra-progreso-relleno');
    const ancho = await relleno.evaluate((el) => parseFloat((el as HTMLElement).style.width));
    expect(ancho).toBeGreaterThanOrEqual(50);
  });

  test('una espera del circuito no se disfraza de conversión', async ({ page }) => {
    await abrirPanel(page);
    await lanzarConversionConProceso(page, {
      documentoId: 102, titulo: 'OFICIO', segundos: 5,
      fase: 'esperando_circuito', faseMs: 2000, faseLimiteMs: 60000,
      proveedor: 'markitdown', intento: 1, intentos: 1, motivoFallback: null,
    });

    await expect(page.getByText(/vuelve en 5[0-8] s/)).toBeVisible();
    // Fase de espera: la barra no avanza, se queda al inicio del tramo de conversión (15 %).
    const relleno = page.locator('.rag-job-actual .barra-progreso--documento .barra-progreso-relleno');
    await expect
      .poll(() => relleno.evaluate((el) => (el as HTMLElement).style.width))
      .toBe('15%');
  });

  test('sin fase (bundle o backend anterior) cae a la barra indeterminada, sin texto de fase', async ({ page }) => {
    await abrirPanel(page);
    // `procesoActual` sin `fase`: exactamente lo que devolvería un backend previo a este cambio.
    await lanzarConversionConProceso(page, { documentoId: 103, titulo: 'ANTIGUO', segundos: 10 });

    await expect(page.locator('.rag-job-actual .barra-progreso-indeterminada')).toBeVisible();
    await expect(page.getByText(/Convirtiendo/)).toHaveCount(0);
  });

  test('un documento generado desde el SGD también llena la barra, no solo la conversión real', async ({ page }) => {
    await abrirPanel(page);
    await lanzarConversionConProceso(page, {
      documentoId: 104, titulo: 'PROVEÍDO 232', segundos: 1,
      fase: 'generando', proveedor: null, intento: 1, intentos: 1, motivoFallback: null,
    });

    await expect(page.getByText('Generando el texto desde los datos del SGD')).toBeVisible();
  });

  test('detener no aborta el documento en vuelo, y el panel lo dice', async ({ page }) => {
    await abrirPanel(page);
    await page.route('**/api/rag/ingesta/conversion', (route) =>
      route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ jobId: 9 }) }),
    );
    // Mientras el trabajo sigue en_curso, "Detener" tiene que estar visible para poder pulsarlo.
    await page.route('**/api/rag/ingesta/9', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 9, tipo: 'conversion', estado: 'en_curso', total: 500, procesados: 12, errores: 0,
          mensaje: null, feInicio: '2026-08-23T20:10:00.000Z', feFin: null,
          procesoActual: {
            documentoId: 105, titulo: 'EL ÚLTIMO', segundos: 90,
            fase: 'convirtiendo', faseMs: 90000, faseLimiteMs: 195000,
            proveedor: 'markitdown', intento: 1, intentos: 1, motivoFallback: null,
          },
        }),
      }),
    );
    await page.getByRole('button', { name: 'Convertir documentos pendientes' }).click();
    await expect(page.getByRole('button', { name: 'Detener' })).toBeVisible();

    const jobCancelado = {
      id: 9, tipo: 'conversion', estado: 'cancelado', total: 500, procesados: 12, errores: 0,
      mensaje: null, feInicio: '2026-08-23T20:10:00.000Z', feFin: '2026-08-23T20:20:00.000Z',
      procesoActual: {
        documentoId: 105, titulo: 'EL ÚLTIMO', segundos: 90,
        fase: 'convirtiendo', faseMs: 90000, faseLimiteMs: 195000,
        proveedor: 'markitdown', intento: 1, intentos: 1, motivoFallback: null,
      },
    };
    await page.route('**/api/rag/ingesta/9/cancelar', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(jobCancelado) }),
    );
    // Re-registrado DESPUÉS de "Detener": si el sondeo siguiera corriendo (por eso este cambio
    // amplió su condición de parada), tiene que ver lo mismo que ya cancelamos, no rebotar a
    // "en_curso" — Playwright prioriza el handler más reciente para peticiones futuras.
    await page.route('**/api/rag/ingesta/9', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(jobCancelado) }),
    );
    await page.getByRole('button', { name: 'Detener' }).click();

    await expect(page.getByText('El trabajo ya no toma documentos nuevos; el que estaba en marcha termina solo.')).toBeVisible();
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

/** Un job de conversión tal y como lo devuelve `GET /api/rag/ingesta/:id`. */
function jobDe(
  tipo: 'conversion' | 'embedding',
  id: number,
  estado: string,
  procesados: number,
  errores = 0,
  total = 500,
) {
  return {
    id, tipo, estado, total, procesados, errores,
    mensaje: null,
    feInicio: '2026-09-01T10:00:00.000Z',
    feFin: estado === 'en_curso' ? null : '2026-09-01T10:30:00.000Z',
  };
}

function comoJson(cuerpo: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(cuerpo) };
}

/**
 * Deja el panel listo para una tanda encadenada — de conversión o de embeddings, según `tipo` — el
 * POST reparte jobIds correlativos y cada job responde `en_curso` la primera vez que se consulta y
 * `completado` a partir de la segunda — que es justo la transición sobre la que el panel decide
 * preguntar si sigue con el próximo lote.
 *
 * Devuelve el contador de lotes lanzados: lo que distingue "continuar" de "detener".
 */
async function simularCadena(
  page: Page,
  opciones: {
    tipo?: 'conversion' | 'embedding';
    procesados?: number;
    errores?: number;
    total?: number;
    segundoLote?: { status: number; cuerpo: unknown };
  } = {},
) {
  const tipo = opciones.tipo ?? 'conversion';
  const total = opciones.total ?? (tipo === 'conversion' ? 500 : 2000);
  const lanzados: number[] = [];

  await page.route(`**/api/rag/ingesta/${tipo === 'conversion' ? 'conversion' : 'embeddings'}`, (route) => {
    lanzados.push(Date.now());
    if (lanzados.length > 1 && opciones.segundoLote) {
      return route.fulfill(comoJson(opciones.segundoLote.cuerpo, opciones.segundoLote.status));
    }
    return route.fulfill(comoJson({ jobId: 100 + lanzados.length }, 202));
  });

  const consultas = new Map<string, number>();
  await page.route('**/api/rag/ingesta/1*', (route) => {
    const id = route.request().url().split('/').pop()!;
    const vistas = (consultas.get(id) ?? 0) + 1;
    consultas.set(id, vistas);
    return route.fulfill(
      comoJson(
        jobDe(
          tipo,
          Number(id),
          vistas > 1 ? 'completado' : 'en_curso',
          opciones.procesados ?? total,
          opciones.errores ?? 0,
          total,
        ),
      ),
    );
  });

  return lanzados;
}

test.describe('Panel RAG — conversión por lotes encadenados', () => {
  test('al terminar un lote pregunta si continuar, con cuenta atrás', async ({ page }) => {
    await abrirPanel(page);
    await simularCadena(page, { procesados: 498, errores: 2 });

    await expect(page.getByRole('checkbox', { name: 'Continuar por lotes (conversión)' })).toBeChecked();
    await page.getByRole('button', { name: 'Convertir documentos pendientes' }).click();

    const dialogo = page.getByRole('alertdialog');
    await expect(dialogo.getByRole('heading', { name: 'Lote 1 terminado' })).toBeVisible();
    await expect(dialogo.getByText('Se procesaron 498 de 500 documento(s) (2 con error).')).toBeVisible();
    await expect(dialogo.getByText(/Quedan 5688 documento\(s\) pendiente\(s\)/)).toBeVisible();
    await expect(dialogo.getByText(/Continúa automáticamente en/)).toBeVisible();
  });

  test('"Continuar ahora" lanza el siguiente lote', async ({ page }) => {
    await abrirPanel(page);
    const lanzados = await simularCadena(page);

    await page.getByRole('button', { name: 'Convertir documentos pendientes' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Continuar ahora' }).click();

    // El diálogo del lote 1 se cierra y el trabajo que se sondea es ya el segundo.
    await expect(page.getByText(/Trabajo #102 \(conversion\)/)).toBeVisible();
    expect(lanzados).toHaveLength(2);

    // Y al terminar ESE lote vuelve a preguntar, contando bien el número de lote.
    await expect(page.getByRole('alertdialog').getByRole('heading', { name: 'Lote 2 terminado' })).toBeVisible();
  });

  test('"No, detener" cierra la cadena sin lanzar otro lote', async ({ page }) => {
    await abrirPanel(page);
    const lanzados = await simularCadena(page, { procesados: 500 });

    await page.getByRole('button', { name: 'Convertir documentos pendientes' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'No, detener' }).click();

    await expect(page.getByText('Conversión detenida tras 1 lote(s): 500 documento(s) convertido(s).')).toBeVisible();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    expect(lanzados).toHaveLength(1);
  });

  test('un lote que no convirtió nada no continúa solo', async ({ page }) => {
    await abrirPanel(page);
    await simularCadena(page, { procesados: 0, errores: 500 });

    await page.getByRole('button', { name: 'Convertir documentos pendientes' }).click();

    const dialogo = page.getByRole('alertdialog');
    await expect(dialogo.getByText(/no convirtió ningún documento/)).toBeVisible();
    await expect(dialogo.getByText(/Continúa automáticamente/)).toHaveCount(0);
  });

  test('cuando ya no quedan pendientes, la cadena termina con el balance', async ({ page }) => {
    await abrirPanel(page);
    await simularCadena(page, {
      procesados: 120,
      // El 404 de `iniciarJobConversion` es la señal de fin: no es un error que mostrar.
      segundoLote: { status: 404, cuerpo: { message: 'No hay documentos pendientes con ese filtro' } },
    });

    await page.getByRole('button', { name: 'Convertir documentos pendientes' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Continuar ahora' }).click();

    await expect(
      page.getByText('Conversión terminada: 120 documento(s) en 1 lote(s). No quedan documentos pendientes.'),
    ).toBeVisible();
    await expect(page.getByText(/No hay documentos pendientes con ese filtro/)).toHaveCount(0);
  });

  test('sin la casilla marcada se hace un solo lote, sin preguntar nada', async ({ page }) => {
    await abrirPanel(page);
    await simularCadena(page);

    await page.getByRole('checkbox', { name: 'Continuar por lotes (conversión)' }).uncheck();
    await page.getByRole('button', { name: 'Convertir documentos pendientes' }).click();

    await expect(page.getByText(/Trabajo #101 \(conversion\)/)).toBeVisible();
    // El trabajo llega a completarse (el sondeo lo ve en el segundo tick) y aun así no hay diálogo.
    await expect(page.getByText(/Trabajo #101 \(conversion\) — completado/)).toBeVisible();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
  });

  test('sin responder en 30 s, continúa sola', async ({ page }) => {
    // Reloj falso: la cuenta atrás real tardaría más que el propio tiempo límite de la prueba.
    await page.clock.install();
    await abrirPanel(page);
    const lanzados = await simularCadena(page);

    await page.getByRole('button', { name: 'Convertir documentos pendientes' }).click();
    await page.clock.runFor(2000); // deja correr el sondeo (1500 ms) hasta ver el lote completado
    await expect(page.getByRole('alertdialog')).toBeVisible();
    expect(lanzados).toHaveLength(1);

    await page.clock.runFor(30_000);
    await expect(page.getByText(/Trabajo #102 \(conversion\)/)).toBeVisible();
    expect(lanzados).toHaveLength(2);
  });
});

test.describe('Panel RAG — embeddings por lotes encadenados', () => {
  test('al terminar un lote de embeddings pregunta si continuar, con cuenta atrás', async ({ page }) => {
    await abrirPanel(page);
    await simularCadena(page, { tipo: 'embedding', procesados: 1998, errores: 2 });

    await expect(page.getByRole('checkbox', { name: 'Continuar por lotes (embeddings)' })).toBeChecked();
    await page.getByRole('button', { name: 'Generar embeddings' }).click();

    const dialogo = page.getByRole('alertdialog');
    await expect(dialogo.getByRole('heading', { name: 'Lote 1 terminado' })).toBeVisible();
    await expect(dialogo.getByText('Se procesaron 1998 de 2000 fragmento(s) (2 con error).')).toBeVisible();
    // PANEL_BASE.corpus.embeddings.chunksSinEmbedding = 119.
    await expect(dialogo.getByText(/Quedan 119 fragmento\(s\) pendiente\(s\)/)).toBeVisible();
    await expect(dialogo.getByText(/Continúa automáticamente en/)).toBeVisible();
  });

  test('"Continuar ahora" lanza el siguiente lote de embeddings', async ({ page }) => {
    await abrirPanel(page);
    const lanzados = await simularCadena(page, { tipo: 'embedding' });

    await page.getByRole('button', { name: 'Generar embeddings' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Continuar ahora' }).click();

    await expect(page.getByText(/Trabajo #102 \(embedding\)/)).toBeVisible();
    expect(lanzados).toHaveLength(2);
    await expect(page.getByRole('alertdialog').getByRole('heading', { name: 'Lote 2 terminado' })).toBeVisible();
  });

  test('"No, detener" cierra la cadena de embeddings sin lanzar otro lote', async ({ page }) => {
    await abrirPanel(page);
    const lanzados = await simularCadena(page, { tipo: 'embedding', procesados: 2000 });

    await page.getByRole('button', { name: 'Generar embeddings' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'No, detener' }).click();

    await expect(
      page.getByText('Ingesta de embeddings detenida tras 1 lote(s): 2000 fragmento(s) embebido(s).'),
    ).toBeVisible();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    expect(lanzados).toHaveLength(1);
  });

  test('un lote de embeddings que no embebió nada no continúa solo', async ({ page }) => {
    await abrirPanel(page);
    await simularCadena(page, { tipo: 'embedding', procesados: 0, errores: 2000 });

    await page.getByRole('button', { name: 'Generar embeddings' }).click();

    const dialogo = page.getByRole('alertdialog');
    await expect(dialogo.getByText(/no embebió ningún fragmento/)).toBeVisible();
    await expect(dialogo.getByText(/Continúa automáticamente/)).toHaveCount(0);
  });

  test('cuando ya no quedan fragmentos pendientes, la cadena de embeddings termina con el balance', async ({ page }) => {
    await abrirPanel(page);
    await simularCadena(page, {
      tipo: 'embedding',
      procesados: 1500,
      // El 404 de `iniciarJobEmbedding` es la señal de fin: no es un error que mostrar.
      segundoLote: { status: 404, cuerpo: { message: 'No hay chunks pendientes de embeber con ese filtro' } },
    });

    await page.getByRole('button', { name: 'Generar embeddings' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Continuar ahora' }).click();

    await expect(
      page.getByText(
        'Ingesta de embeddings terminada: 1500 fragmento(s) en 1 lote(s). No quedan fragmentos pendientes.',
      ),
    ).toBeVisible();
    await expect(page.getByText(/No hay chunks pendientes de embeber/)).toHaveCount(0);
  });

  test('el botón "Detener" funciona sobre un job de embeddings, sin "Pausar" ni "Reanudar"', async ({ page }) => {
    await abrirPanel(page);
    await page.route('**/api/rag/ingesta/embeddings', (route) => route.fulfill(comoJson({ jobId: 55 }, 202)));
    await page.route('**/api/rag/ingesta/55', (route) =>
      route.fulfill(comoJson(jobDe('embedding', 55, 'en_curso', 800, 0, 2000))),
    );

    await page.getByRole('button', { name: 'Generar embeddings' }).click();
    await expect(page.getByRole('button', { name: 'Detener' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pausar' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Reanudar' })).toHaveCount(0);

    const jobCancelado = jobDe('embedding', 55, 'cancelado', 800, 0, 2000);
    await page.route('**/api/rag/ingesta/55/cancelar', (route) => route.fulfill(comoJson(jobCancelado)));
    await page.route('**/api/rag/ingesta/55', (route) => route.fulfill(comoJson(jobCancelado)));
    await page.getByRole('button', { name: 'Detener' }).click();

    await expect(page.getByText(/Trabajo #55 \(embedding\) — cancelado/)).toBeVisible();
  });
});
