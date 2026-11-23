import { conToken, ref, type Paths } from '../comunes';
import { TAG } from '../tags';

export const pathsAuth: Paths = {
  '/health': {
    get: {
      tags: [TAG.sistema],
      'x-uso': 'integracion',
      operationId: 'health',
      summary: 'Estado del servicio',
      description: 'Responde `ok` si el proceso está vivo. Lo usa el healthcheck de Docker. No consulta las bases de datos.',
      security: [],
      responses: {
        200: {
          description: 'El servicio está en marcha.',
          content: {
            'application/json': {
              schema: { type: 'object', properties: { status: { type: 'string', enum: ['ok'] } } },
              example: { status: 'ok' },
            },
          },
        },
      },
    },
  },

  '/api/auth/login': {
    post: {
      tags: [TAG.auth],
      'x-uso': 'integracion',
      operationId: 'login',
      summary: 'Iniciar sesión con las credenciales del SGD',
      description:
        'Verifica usuario y clave contra el SGD y devuelve un JWT y los datos del usuario.\n\n' +
        '**Para sistemas externos (login delegado):** reenviar aquí el usuario y la clave que el usuario ' +
        'escribió en el propio formulario del sistema externo. Un 200 significa que las credenciales son ' +
        'válidas y que el usuario está habilitado en esta aplicación. **La clave no debe guardarse.**\n\n' +
        '**Límites:**\n' +
        '- 20 intentos por minuto **por IP**. Si todos los logins salen de un mismo servidor, comparten ese cupo.\n' +
        '- Bloqueo del usuario tras varios fallos seguidos (por defecto 10 en 15 minutos), cuente o no el ' +
        'intento desde el frontend propio.\n\n' +
        'El mensaje es el mismo para usuario inexistente y clave incorrecta, para no permitir enumerar usuarios.',
      security: [],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['usuario', 'clave'],
              properties: {
                usuario: { type: 'string', description: 'Código de usuario del SGD. Se ignoran espacios al inicio y al final.', example: 'JPEREZ' },
                clave: { type: 'string', format: 'password', description: 'Contraseña del SGD.', example: '********' },
              },
            },
          },
        },
      },
      responses: {
        200: {
          description: 'Credenciales válidas.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['token', 'usuario'],
                properties: {
                  token: {
                    type: 'string',
                    description: 'JWT (HS256). Enviar como `Authorization: Bearer <token>`. Caduca según `JWT_EXPIRACION` del servidor.',
                    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
                  },
                  usuario: ref.esquema('Usuario'),
                },
              },
            },
          },
        },
        400: {
          description: 'Falta el usuario o la clave.',
          content: { 'application/json': { schema: ref.esquema('Error'), example: { message: 'Indique usuario y contraseña' } } },
        },
        401: {
          description: 'Usuario inexistente o clave incorrecta. Si es la clave, se informa cuántos intentos quedan.',
          content: {
            'application/json': {
              schema: ref.esquema('Error'),
              example: { message: 'Usuario o contraseña incorrectos. Intentos restantes: 7.' },
            },
          },
        },
        403: {
          description: 'El usuario existe pero está inactivo en el SGD o deshabilitado en esta aplicación.',
          content: {
            'application/json': {
              schema: ref.esquema('Error'),
              example: { message: 'Su acceso a esta aplicación está deshabilitado.' },
            },
          },
        },
        429: {
          description: 'Demasiados intentos, de esta IP (límite por minuto) o de este usuario (bloqueo temporal).',
          headers: {
            RateLimit: {
              description: 'Solo en el límite por IP: cupo restante y segundos hasta reiniciarse (draft-7).',
              schema: { type: 'string' },
            },
          },
          content: {
            'application/json': {
              schema: ref.esquema('Error'),
              examples: {
                porIp: { summary: 'Límite por IP', value: { message: 'Demasiados intentos desde esta dirección. Espere un minuto.' } },
                porUsuario: {
                  summary: 'Usuario bloqueado',
                  value: { message: 'Demasiados intentos fallidos. Vuelva a intentarlo en 15 minuto(s).' },
                },
              },
            },
          },
        },
        500: {
          description: 'Error inesperado.',
          content: { 'application/json': { schema: ref.esquema('Error'), example: { message: 'Error al procesar el inicio de sesión' } } },
        },
      },
    },
  },

  '/api/auth/sesion': {
    get: {
      tags: [TAG.auth],
      'x-uso': 'integracion',
      operationId: 'obtenerSesion',
      summary: 'Sesión vigente',
      description:
        'Devuelve el usuario del token con los roles y permisos **leídos de la BD en este momento**. ' +
        'Sirve para que un sistema externo compruebe que el token sigue siendo válido y que el usuario no fue deshabilitado.',
      security: conToken,
      responses: {
        200: {
          description: 'Token válido.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['usuario'],
                properties: {
                  usuario: {
                    allOf: [
                      ref.esquema('Usuario'),
                      {
                        type: 'object',
                        properties: {
                          cempCodemp: { type: 'string', nullable: true, description: 'Código de empleado en el SGD.', example: '000123' },
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
        },
        401: ref.respuesta('NoAutenticado'),
        403: ref.respuesta('SinPermiso'),
        500: ref.respuesta('ErrorInterno'),
      },
    },
  },
};
