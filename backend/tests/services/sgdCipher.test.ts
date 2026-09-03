type Cipher = typeof import('../../src/services/sgdCipher');

let cipher: Cipher;

const SECRETO = 'SgDPasswordSecretPasswor';

beforeAll(() => {
  process.env.SGD_SECRET_KEY_PASSWORD = SECRETO;
  jest.isolateModules(() => {
    cipher = require('../../src/services/sgdCipher');
  });
});

describe('sgdCipher — réplica del cifrado del SGD', () => {
  it('produce hex en mayúsculas en bloques de 16 bytes', () => {
    const salida = cipher.cifrarSgd('clave123');

    expect(salida).toMatch(/^[0-9A-F]+$/);
    // AES-128 con PKCS#7: 8 caracteres caben en un bloque -> 16 bytes -> 32 hex.
    expect(salida).toHaveLength(32);
    // 16 caracteres exactos fuerzan un bloque de relleno completo.
    expect(cipher.cifrarSgd('0123456789abcdef')).toHaveLength(64);
  });

  it('es determinista: el SGD compara cifrar(entrada) con el valor guardado', () => {
    expect(cipher.cifrarSgd('misma-clave')).toBe(cipher.cifrarSgd('misma-clave'));
  });

  /**
   * Vectores fijos calculados con el secreto real del `.env`. Fijan los cuatro parámetros del
   * algoritmo —SHA-1, truncado a 16 bytes, ECB con PKCS#7 y hex en mayúsculas—: si alguien
   * cambia cualquiera de ellos, este test cae en vez de dejar a 188 usuarios sin poder entrar.
   */
  it.each([
    ['clave123', '7EB54275DE16ECB16FDA85BCB57E1FE2'],
    ['0123456789abcdef', 'AEFF06EF4F752C7C7BBB1CDAD33F92F8B050B88D9BC44B164832A56A9D4BEC0C'],
    [
      'Contraseña con ñ y símbolos $!°',
      '5CAE67F0774F7313B2EE83B7427F89D26F1DB8EFA44541B374CA710820EAF59D770C0CF88CAFE18E23177277E4F765EA',
    ],
  ])('cifra %j al valor conocido', (plano, esperado) => {
    expect(cipher.cifrarSgd(plano)).toBe(esperado);
  });

  it('acepta acentos y eñes en la contraseña', () => {
    // El SGD guarda las claves en UTF-8; una contraseña con ñ debe validar igual que cualquier otra.
    const guardado = cipher.cifrarSgd('Ñandú2026');
    expect(cipher.verificarClaveSgd('Ñandú2026', guardado)).toBe(true);
    expect(cipher.verificarClaveSgd('Nandu2026', guardado)).toBe(false);
  });

  it('cambiar el secreto cambia el resultado', () => {
    expect(cipher.cifrarSgd('x', 'otro-secreto')).not.toBe(cipher.cifrarSgd('x', SECRETO));
  });

  describe('verificarClaveSgd', () => {
    const almacenado = () => cipher.cifrarSgd('la-buena');

    it('acepta la contraseña correcta', () => {
      expect(cipher.verificarClaveSgd('la-buena', almacenado())).toBe(true);
    });

    it('rechaza una incorrecta', () => {
      expect(cipher.verificarClaveSgd('la-mala', almacenado())).toBe(false);
    });

    it('tolera espacios y minúsculas en el valor de la BD', () => {
      // `cclave` es varchar y en el SGD aparece con espacios sueltos.
      expect(cipher.verificarClaveSgd('la-buena', `  ${almacenado().toLowerCase()}  `)).toBe(true);
    });

    it('rechaza sin lanzar cuando el valor almacenado falta o es basura', () => {
      expect(cipher.verificarClaveSgd('x', null)).toBe(false);
      expect(cipher.verificarClaveSgd('x', '')).toBe(false);
      expect(cipher.verificarClaveSgd('x', 'no-es-hex')).toBe(false);
      // Distinta longitud: `timingSafeEqual` lanzaría si no se comprobara antes.
      expect(cipher.verificarClaveSgd('x', 'AABB')).toBe(false);
    });
  });
});
