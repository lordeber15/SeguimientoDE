import type { Express } from 'express';
import swaggerUi from 'swagger-ui-express';
import { construirDocumento } from './openapi';

/**
 * Solo con `SWAGGER_HABILITADO=true`. No sirve `NODE_ENV`: el `.env` lo fija en `production`
 * también en el Docker local, y publicar el mapa completo de la API por descuido no debe pasar.
 */
export function swaggerHabilitado(): boolean {
  return process.env.SWAGGER_HABILITADO === 'true';
}

export function montarSwagger(app: Express) {
  const documento = construirDocumento();

  // Antes que la UI: `swaggerUi.serve` atiende todo lo que cuelga de /api/docs.
  app.get('/api/docs/openapi.json', (_req, res) => res.json(documento));
  app.use(
    '/api/docs',
    swaggerUi.serve,
    swaggerUi.setup(documento, {
      customSiteTitle: 'Sistema de Seguimiento — API',
      swaggerOptions: {
        // Que el token puesto en «Authorize» sobreviva a recargar la página.
        persistAuthorization: true,
        // Sin esto, la UI envía el spec a validator.swagger.io: no debe salir de la red.
        validatorUrl: null,
        docExpansion: 'none',
        tagsSorter: 'alpha',
      },
    }),
  );
}
