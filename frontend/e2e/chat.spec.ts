import { test, expect, type Page } from '@playwright/test';
import { iniciarSesionSimulada } from './sesion';

const ESTADO_INGESTA_VACIO = {
  total: 0, listos: 0, convertidos: 0, pendientes: 0, sinTexto: 0, error: 0, noSoportado: 0, completo: false,
};

/** Deja la app en la pestaña "Chat" → "Por expediente", con `/api/dependencias` ya simulado
 * (la vista por defecto es "Seguimiento" y la pide al montar). */
async function abrirChatPorExpediente(page: Page) {
  await page.route('**/api/dependencias', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );

  await iniciarSesionSimulada(page);
  await page.goto('/');

  await page.getByRole('button', { name: 'Chat' }).click();
  await page.getByRole('tab', { name: 'Por expediente' }).click();
}

test.describe('Chat — buscar expediente por su número compuesto', () => {
  test('un solo resultado se selecciona solo', async ({ page }) => {
    await page.route('**/api/rag/chat/expedientes/buscar**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { nuAnnExp: '2026', nuSecExp: '0000000062', numeroExpediente: 'DE000020260000062', documentos: 12, ingestados: 12 },
        ]),
      }),
    );
    await page.route('**/api/rag/chat/sesiones/expediente/**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: 'null' }),
    );
    await page.route('**/api/rag/chat/expediente/*/*/estado', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ESTADO_INGESTA_VACIO) }),
    );

    await abrirChatPorExpediente(page);

    await page.getByLabel('N° de expediente').fill('DE000020260000062');
    await page.getByRole('button', { name: 'Buscar' }).click();

    await expect(page.locator('.chat-expediente-elegido')).toContainText('DE000020260000062');
    await expect(page.getByRole('button', { name: 'Cambiar' })).toBeVisible();
  });

  test('varios resultados muestran una lista para elegir', async ({ page }) => {
    await page.route('**/api/rag/chat/expedientes/buscar**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { nuAnnExp: '2026', nuSecExp: '0000000062', numeroExpediente: 'DE000020260000062', documentos: 12, ingestados: 12 },
          { nuAnnExp: '2026', nuSecExp: '0000000075', numeroExpediente: 'DE000020260000075', documentos: 3, ingestados: 0 },
        ]),
      }),
    );
    await page.route('**/api/rag/chat/sesiones/expediente/**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: 'null' }),
    );
    await page.route('**/api/rag/chat/expediente/*/*/estado', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ESTADO_INGESTA_VACIO) }),
    );

    await abrirChatPorExpediente(page);

    await page.getByLabel('N° de expediente').fill('DE0000');
    await page.getByRole('button', { name: 'Buscar' }).click();

    await expect(page.getByRole('button', { name: 'DE000020260000062' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'DE000020260000075' })).toBeVisible();

    await page.getByRole('button', { name: 'DE000020260000075' }).click();
    await expect(page.locator('.chat-expediente-elegido')).toContainText('DE000020260000075');
  });

  test('sin resultados muestra el aviso y "Cambiar" vuelve al buscador', async ({ page }) => {
    await page.route('**/api/rag/chat/expedientes/buscar**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
    );

    await abrirChatPorExpediente(page);

    await page.getByLabel('N° de expediente').fill('NOEXISTE001');
    await page.getByRole('button', { name: 'Buscar' }).click();

    await expect(page.getByText('No se encontró ningún expediente con ese número.')).toBeVisible();
  });

  test('el botón Enviar queda deshabilitado hasta elegir un expediente', async ({ page }) => {
    await abrirChatPorExpediente(page);

    const entrada = page.getByPlaceholder('Escriba su pregunta…');
    await entrada.fill('¿Cuál es el estado de este expediente?');

    await expect(page.getByRole('button', { name: 'Enviar' })).toBeDisabled();
  });
});

const TEXTO_CHUNK = '# DIRECCIÓN EJECUTIVA\n\nPROVEIDO 000225-2026-MINEDU-VMGP/UE118/DE (SGD)\n\n'
  + '## EXPEDIENTE : DE000020260000062\n\nAtender según corresponda.';

const RESPUESTA_CHAT = {
  sesionId: 1,
  mensajeId: 10,
  texto: 'La solicitud fue derivada a la Dirección Ejecutiva [D1] para su atención.',
  citas: [
    {
      numero: 1,
      chunkId: 8421,
      documentoId: 55,
      nuAnn: '2026',
      nuEmi: '0000225',
      nuAne: 0,
      extracto: 'DIRECCIÓN EJECUTIVA PROVEIDO 000225-2026-MINEDU-VMGP/UE118/DE (SGD)',
      chars: TEXTO_CHUNK.length,
      rutaTitulos: 'DIRECCIÓN EJECUTIVA > Atender en 0 días',
      usada: true,
    },
  ],
  candidatosVec: 8,
  candidatosFts: 5,
  marcadoresAlucinados: 0,
};

test.describe('Chat — las citas se cargan solo al desplegarlas', () => {
  /** Deja un expediente elegido y una respuesta ya en pantalla, contando las llamadas al chunk. */
  async function prepararConversacion(page: Page) {
    const pedidosChunk: string[] = [];

    await page.route('**/api/rag/chat/expedientes/buscar**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { nuAnnExp: '2026', nuSecExp: '0000000062', numeroExpediente: 'DE000020260000062', documentos: 12, ingestados: 12 },
        ]),
      }),
    );
    await page.route('**/api/rag/chat/sesiones/expediente/**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: 'null' }),
    );
    await page.route('**/api/rag/chat/expediente/*/*/estado', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ESTADO_INGESTA_VACIO) }),
    );
    await page.route('**/api/rag/chat/expediente/2026/0000000062', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RESPUESTA_CHAT) }),
    );
    await page.route('**/api/rag/chat/chunks/*', (route) => {
      pedidosChunk.push(route.request().url());
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ texto: TEXTO_CHUNK }),
      });
    });

    await abrirChatPorExpediente(page);
    await page.getByLabel('N° de expediente').fill('DE000020260000062');
    await page.getByRole('button', { name: 'Buscar' }).click();
    await expect(page.locator('.chat-expediente-elegido')).toContainText('DE000020260000062');

    await page.getByPlaceholder('Escriba su pregunta…').fill('¿A quién se derivó?');
    await page.getByRole('button', { name: 'Enviar' }).click();

    return pedidosChunk;
  }

  test('la cita cerrada no pide el fragmento; al desplegarla lo pide una sola vez', async ({ page }) => {
    const pedidosChunk = await prepararConversacion(page);

    const cita = page.locator('.chat-cita');
    const cabecera = cita.getByRole('button', { name: /DIRECCIÓN EJECUTIVA/ });
    await expect(cita).toBeVisible();

    // Cerrada: ni el texto del fragmento en el DOM ni una petición para traerlo.
    expect(pedidosChunk).toHaveLength(0);
    await expect(page.locator('.chat-cita-texto')).toHaveCount(0);

    await cabecera.click();

    await expect(page.locator('.chat-cita-texto')).toBeVisible();
    expect(pedidosChunk).toHaveLength(1);
    expect(pedidosChunk[0]).toContain('/api/rag/chat/chunks/8421');

    // El markdown se pinta como jerarquía real, no con los "#" literales de antes.
    await expect(page.locator('.chunk-md-h1')).toHaveText('DIRECCIÓN EJECUTIVA');
    await expect(page.locator('.chunk-md-h2')).toHaveText('EXPEDIENTE : DE000020260000062');
    await expect(page.locator('.chat-cita-texto')).not.toContainText('# DIRECCIÓN');

    // Cerrar y reabrir no vuelve a pedirlo: el fragmento ya está en memoria.
    await cabecera.click();
    await cabecera.click();
    await expect(page.locator('.chat-cita-texto')).toBeVisible();
    expect(pedidosChunk).toHaveLength(1);
  });

  test('el marcador [D1] del texto es un badge que despliega su cita', async ({ page }) => {
    await prepararConversacion(page);

    // El marcador dejó de ser el texto plano "[D1]": ahora es un botón que abre su cita.
    const marcador = page.getByRole('button', { name: 'Ver la fuente D1' });
    await expect(marcador).toBeVisible();
    await expect(page.locator('.chat-cita')).not.toHaveClass(/is-abierta/);

    await marcador.click();

    await expect(page.locator('.chat-cita')).toHaveClass(/is-abierta/);
    await expect(page.locator('.chat-cita-texto')).toBeVisible();
  });
});
