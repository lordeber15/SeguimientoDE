import type { OpenAPIV3 } from 'openapi-types';

/**
 * Extensiones propias de cada operación. `x-uso` es obligatorio: así el compilador no deja
 * documentar un endpoint sin decir si es de integración o interno.
 */
export interface ExtensionesOperacion {
  'x-uso': 'integracion' | 'interno';
  /** Permiso que exige `requierePermiso(...)`. Omitir solo en rutas públicas o sin permiso concreto. */
  'x-permiso'?: string;
}

export type Paths = OpenAPIV3.PathsObject<ExtensionesOperacion>;

/** `$ref` a un componente, para no repetir la ruta completa en cada archivo de paths. */
export const ref = {
  esquema: (nombre: string): OpenAPIV3.ReferenceObject => ({ $ref: `#/components/schemas/${nombre}` }),
  respuesta: (nombre: string): OpenAPIV3.ReferenceObject => ({ $ref: `#/components/responses/${nombre}` }),
  parametro: (nombre: string): OpenAPIV3.ReferenceObject => ({ $ref: `#/components/parameters/${nombre}` }),
};

/** Seguridad de las operaciones protegidas: JWT de `POST /api/auth/login`. */
export const conToken: OpenAPIV3.SecurityRequirementObject[] = [{ bearerAuth: [] }];

/**
 * Respuestas de error que añade `requiereAuth` + `requierePermiso` a toda ruta protegida. Se
 * mezclan en cada operación para no olvidar ninguna.
 */
export const erroresSesion: OpenAPIV3.ResponsesObject = {
  401: ref.respuesta('NoAutenticado'),
  403: ref.respuesta('SinPermiso'),
  500: ref.respuesta('ErrorInterno'),
};

export const componentes: OpenAPIV3.ComponentsObject = {
  securitySchemes: {
    bearerAuth: {
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
      description:
        'Token obtenido en `POST /api/auth/login`. Se envía como `Authorization: Bearer <token>`. ' +
        'Los roles y permisos se vuelven a leer de la BD en cada petición: retirar un permiso surte ' +
        'efecto de inmediato, sin esperar a que caduque el token.',
    },
  },

  schemas: {
    Error: {
      type: 'object',
      description:
        'Forma común de todos los errores. Algunos endpoints añaden campos extra junto a `message` ' +
        '(se indica en cada caso).',
      required: ['message'],
      properties: {
        message: { type: 'string', description: 'Mensaje legible, apto para mostrarlo al usuario.' },
      },
      additionalProperties: true,
      example: { message: 'No tiene permiso para esta operación' },
    },

    ErrorSesion: {
      allOf: [
        ref.esquema('Error'),
        {
          type: 'object',
          properties: {
            expirado: {
              type: 'boolean',
              description: '`true` si el token caducó: hay que volver a iniciar sesión.',
            },
          },
        },
      ],
    },

    Usuario: {
      type: 'object',
      description: 'Usuario autenticado, con roles y permisos vigentes en esta aplicación.',
      required: ['codUser', 'nombre', 'roles', 'permisos'],
      properties: {
        codUser: { type: 'string', description: 'Código de usuario del SGD (el mismo con el que inicia sesión).', example: 'JPEREZ' },
        nombre: { type: 'string', description: 'Nombre completo del empleado.', example: 'JUAN PÉREZ GÓMEZ' },
        nuDni: { type: 'string', nullable: true, description: 'DNI del empleado.', example: '41234567' },
        coDependencia: { type: 'string', nullable: true, description: 'Código de la dependencia (oficina) del usuario en el SGD.', example: '0012' },
        deDependencia: { type: 'string', nullable: true, description: 'Nombre de la dependencia.', example: 'OFICINA DE ADMINISTRACIÓN' },
        roles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Roles de esta aplicación (`admin`, `jefe`, `consulta`…). No son roles del SGD.',
          example: ['consulta'],
        },
        permisos: {
          type: 'array',
          items: { type: 'string' },
          description: 'Permisos efectivos derivados de los roles. Son los que exige cada endpoint (`x-permiso`).',
          example: ['seguimiento.ver', 'documentos.ver', 'pdf.unificar'],
        },
      },
    },
  },

  responses: {
    SolicitudInvalida: {
      description: 'Parámetros o cuerpo de la petición inválidos.',
      content: { 'application/json': { schema: ref.esquema('Error'), example: { message: 'Año o secuencia de expediente inválido' } } },
    },
    NoAutenticado: {
      description: 'Falta el token, es inválido, caducó o el usuario ya no existe.',
      content: {
        'application/json': {
          schema: ref.esquema('ErrorSesion'),
          examples: {
            sinToken: { summary: 'Sin cabecera Authorization', value: { message: 'Falta el token de sesión' } },
            expirado: { summary: 'Token caducado', value: { message: 'La sesión ha caducado. Vuelva a entrar.', expirado: true } },
            invalido: { summary: 'Token alterado o firmado con otra clave', value: { message: 'Sesión inválida', expirado: false } },
          },
        },
      },
    },
    SinPermiso: {
      description: 'El usuario está deshabilitado en esta aplicación o no tiene el permiso que exige el endpoint.',
      content: {
        'application/json': {
          schema: ref.esquema('Error'),
          examples: {
            sinPermiso: { summary: 'Falta el permiso', value: { message: 'No tiene permiso para esta operación' } },
            deshabilitado: { summary: 'Usuario deshabilitado', value: { message: 'Su acceso a esta aplicación está deshabilitado.' } },
          },
        },
      },
    },
    NoEncontrado: {
      description: 'El recurso solicitado no existe.',
      content: { 'application/json': { schema: ref.esquema('Error') } },
    },
    ErrorInterno: {
      description: 'Error inesperado del servidor. El detalle queda en los logs, no en la respuesta.',
      content: { 'application/json': { schema: ref.esquema('Error'), example: { message: 'Error al procesar la operación' } } },
    },
  },

  parameters: {
    NuAnnExp: {
      name: 'nuAnnExp',
      in: 'path',
      required: true,
      description: 'Año del expediente (4 dígitos).',
      schema: { type: 'string', pattern: '^\\d{4}$', example: '2026' },
    },
    NuSecExp: {
      name: 'nuSecExp',
      in: 'path',
      required: true,
      description: 'Número correlativo del expediente dentro del año (hasta 10 dígitos, con o sin ceros a la izquierda).',
      schema: { type: 'string', pattern: '^\\d{1,10}$', example: '0000000265' },
    },
    JobId: {
      name: 'jobId',
      in: 'path',
      required: true,
      description: 'Identificador del trabajo asíncrono devuelto al crearlo.',
      schema: { type: 'string' },
    },
  },
};
