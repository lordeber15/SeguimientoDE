import type { OpenAPIV3 } from 'openapi-types';
import { componentes } from './comunes';
import { pathsAuth } from './sgd/auth';
import { tags } from './tags';

const descripcion = `
API del Sistema de Seguimiento sobre el SGD (gestión documental) y el STD (trámite documentario
legado). Las bases de datos del SGD y del STD se consultan **en solo lectura**.

## Cómo leer esta documentación

- **[Integración]**: endpoints pensados para que otros sistemas los consuman. Se mantienen estables.
- **[Interno]**: los usa el frontend propio (paneles de administración, RAG, dashboard). Pueden
  cambiar sin aviso; no conviene integrarse con ellos.
- \`x-permiso\` en cada operación indica el permiso que exige. Los permisos dependen de los roles
  asignados al usuario **en esta aplicación**, no en el SGD.

## Login delegado (sistemas externos)

Un sistema externo puede autenticar a sus usuarios con las **mismas credenciales del SGD** sin
conocer ni almacenar contraseñas:

1. Su formulario de login reenvía \`usuario\` y \`clave\` a \`POST /api/auth/login\`.
2. Un 200 confirma la identidad y devuelve un JWT y los datos del usuario (DNI, dependencia, roles, permisos).
3. Para llamar a la API en nombre del usuario: \`Authorization: Bearer <token>\`.
4. \`GET /api/auth/sesion\` comprueba si el token sigue vigente y si el usuario sigue habilitado.

Si el token caduca, la respuesta es 401 con \`expirado: true\`: hay que volver a pedir las credenciales.

## Errores

Todos los errores devuelven \`{ "message": "..." }\`, con un texto apto para mostrarlo al usuario.
`.trim();

export function construirDocumento(): OpenAPIV3.Document {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Sistema de Seguimiento — API',
      version: '1.0.0',
      description: descripcion,
    },
    servers: [{ url: '/', description: 'Este servidor' }],
    tags,
    // Por defecto toda operación exige token; las públicas lo anulan con `security: []`.
    security: [{ bearerAuth: [] }],
    paths: {
      ...pathsAuth,
    },
    components: componentes,
  };
}
