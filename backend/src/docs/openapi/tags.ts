import type { OpenAPIV3 } from 'openapi-types';

/**
 * Cada tag lleva el prefijo de uso en el nombre para que Swagger UI lo muestre en la agrupación:
 * los integradores consumen solo lo marcado como [Integración]. Lo [Interno] lo usa el frontend
 * propio y puede cambiar sin aviso.
 */
export const TAG = {
  sistema: '[Integración] Sistema',
  auth: '[Integración] Autenticación',
} as const;

export const tags: OpenAPIV3.TagObject[] = [
  { name: TAG.sistema, description: 'Estado del servicio. No requiere autenticación.' },
  {
    name: TAG.auth,
    description:
      'Inicio de sesión con las credenciales del SGD y consulta de la sesión vigente. Es el punto de ' +
      'entrada de cualquier sistema externo: ver «Login delegado» en la descripción general.',
  },
];
