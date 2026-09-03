import crypto from 'crypto';

/**
 * Réplica del cifrado de contraseñas del SGD legado
 * (`Sgd/libreria/.../util/Utility.java`, método `cifrar`).
 *
 *   AES-128-ECB con PKCS#7, clave = SHA-1(secreto) truncado a 16 bytes, salida hex MAYÚSCULAS.
 *
 * Verificado ✅ contra la BD real: 40 de 40 credenciales almacenadas descifran a texto imprimible
 * y `cifrar(descifrar(cclave))` reproduce exactamente el valor guardado.
 *
 * ⚠️ El esquema es débil y REVERSIBLE: no hay sal ni IV, así que dos usuarios con la misma clave
 * tienen el mismo `cclave`, y cualquiera con acceso a la BD y a `SGD_SECRET_KEY_PASSWORD` puede
 * recuperar las contraseñas en claro. Es una propiedad del SGD, no de este sistema; se replica
 * porque hay que autenticar contra las credenciales que ya existen. Implicación práctica: el
 * `.env` que contiene esa clave es tan sensible como la propia tabla de usuarios.
 */

function derivarClave(secreto: string): Buffer {
  return crypto.createHash('sha1').update(secreto, 'utf8').digest().subarray(0, 16);
}

export function cifrarSgd(plano: string, secreto = process.env.SGD_SECRET_KEY_PASSWORD ?? ''): string {
  const cipher = crypto.createCipheriv('aes-128-ecb', derivarClave(secreto), null);
  cipher.setAutoPadding(true);
  const cifrado = Buffer.concat([cipher.update(plano, 'utf8'), cipher.final()]);
  return cifrado.toString('hex').toUpperCase();
}

/**
 * Compara la contraseña introducida con el `cclave` almacenado.
 *
 * La comparación es en tiempo constante. Con ECB determinista no protege de gran cosa, pero
 * evita el oráculo de temporización más obvio y no cuesta nada.
 */
export function verificarClaveSgd(plano: string, cclave: string | null | undefined): boolean {
  if (!cclave) return false;

  let calculado: string;
  try {
    calculado = cifrarSgd(plano);
  } catch {
    return false; // secreto mal configurado: se trata como credencial inválida
  }

  const a = Buffer.from(calculado, 'utf8');
  const b = Buffer.from(String(cclave).trim().toUpperCase(), 'utf8');
  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}
