/**
 * `procesoAgrupamiento.ts` es todo funciones puras — se prueba sin mocks ni BD, a diferencia del
 * resto de servicios. Los casos de ejemplo son asuntos REALES de la instancia verificada el
 * 2026-09-02, no inventados: si el criterio se afina, estos son los que tienen que seguir cayendo
 * donde caen.
 */
import {
  agruparAsuntos,
  claveDeProceso,
  esqueletoAsunto,
  normalizarAsunto,
  similitudAsuntos,
} from '../../src/services/procesoAgrupamiento';

describe('esqueletoAsunto — quita lo que hace único a un asunto sin describir el trámite', () => {
  it('borra el número de expediente y deja el trámite: dos pagos distintos dan el mismo esqueleto', () => {
    const a = esqueletoAsunto('PRESENTACION DE DOCUMENTACION PARA PAGO DE CONSULTORIA SCCP 169-2026');
    const b = esqueletoAsunto('Presentación de documentación para pago de consultoría SCCP 170-2026');

    expect(a).toBe('PRESENTACION DE DOCUMENTACION PARA PAGO DE CONSULTORIA SCCP');
    expect(b).toBe(a);
  });

  it('borra numeración con N°, fechas y códigos alfanuméricos', () => {
    expect(esqueletoAsunto('REMITO INFORME N° 007-2026-OGA')).toBe('REMITO INFORME');
    expect(esqueletoAsunto('ACTA DE REUNION DEL 12/03/2026')).toBe('ACTA DE REUNION DEL');
    expect(esqueletoAsunto('CONFORMIDAD RJ 034-2026-MINEDU')).toBe('CONFORMIDAD RJ');
  });

  it('es una transformación DISTINTA de normalizarAsunto, que sí conserva los números', () => {
    const crudo = 'Remito Informe N° 007-2026-OGA';
    expect(normalizarAsunto(crudo)).toBe('REMITO INFORME N° 007-2026-OGA');
    expect(esqueletoAsunto(crudo)).toBe('REMITO INFORME');
  });

  it('devuelve null si no queda texto útil — ese expediente queda sin familia, no en una familia basura', () => {
    expect(esqueletoAsunto(null)).toBeNull();
    expect(esqueletoAsunto('')).toBeNull();
    expect(esqueletoAsunto('N° 123-2026')).toBeNull();
    expect(esqueletoAsunto('2026')).toBeNull();
    expect(esqueletoAsunto('DE')).toBeNull();
  });
});

describe('similitudAsuntos', () => {
  it('vale 1 para textos idénticos y baja al alejarse', () => {
    expect(similitudAsuntos('PAGO DE CONSULTORIA', 'PAGO DE CONSULTORIA')).toBe(1);
    expect(similitudAsuntos('PAGO DE CONSULTORIA', 'RENOVACION DE CARTA FIANZA')).toBeLessThan(0.4);
  });

  it('trámites realmente distintos quedan lejos del umbral de 0,55', () => {
    const pago = esqueletoAsunto('PRESENTACION DE DOCUMENTACION PARA PAGO DE CONSULTORIA SCCP 169-2026')!;
    const fianza = esqueletoAsunto('RENOVACION DE CARTA FIANZA')!;
    expect(similitudAsuntos(pago, fianza)).toBeLessThan(0.55);
  });
});

describe('agruparAsuntos', () => {
  const entrada = (esqueleto: string, frecuencia = 1) => ({ esqueleto, frecuencia });

  it('junta variantes del mismo trámite y separa trámites distintos', () => {
    const familias = agruparAsuntos(
      [
        entrada('PRESENTACION DE DOCUMENTACION PARA PAGO DE CONSULTORIA', 400),
        entrada('PRESENTACION DE DOCUMENTACION PARA PAGO DE CONSULTORIA MENSUAL', 20),
        entrada('RENOVACION DE CARTA FIANZA', 50),
      ],
      0.55,
    );

    const clavePago = familias.get('PRESENTACION DE DOCUMENTACION PARA PAGO DE CONSULTORIA')!.clave;
    expect(familias.get('PRESENTACION DE DOCUMENTACION PARA PAGO DE CONSULTORIA MENSUAL')!.clave)
      .toBe(clavePago);
    expect(familias.get('RENOVACION DE CARTA FIANZA')!.clave).not.toBe(clavePago);
  });

  it('el líder es el más frecuente, y da nombre a toda la familia', () => {
    const familias = agruparAsuntos(
      [
        entrada('PAGO DE CONSULTORIA MENSUAL', 3),
        entrada('PAGO DE CONSULTORIA', 100),
      ],
      0.55,
    );
    expect(familias.get('PAGO DE CONSULTORIA MENSUAL')!.nombre).toBe('PAGO DE CONSULTORIA');
  });

  it('es DETERMINISTA: el orden en que llegan los asuntos no cambia las familias', () => {
    const entradas = [
      entrada('PAGO DE CONSULTORIA', 10),
      entrada('RENOVACION DE CARTA FIANZA', 10),
      entrada('PAGO DE CONSULTORIA MENSUAL', 4),
      entrada('ENTREGA DE DOCUMENTOS', 7),
    ];
    const directo = agruparAsuntos(entradas, 0.55);
    const alReves = agruparAsuntos([...entradas].reverse(), 0.55);

    for (const [esqueleto, familia] of directo) {
      expect(alReves.get(esqueleto)!.clave).toBe(familia.clave);
    }
  });

  it('un umbral más alto fragmenta y uno más bajo mezcla — el calibrado importa', () => {
    const entradas = [entrada('PAGO DE CONSULTORIA', 10), entrada('PAGO DE CONSULTORIA MENSUAL', 4)];

    const distintas = agruparAsuntos(entradas, 0.95);
    expect(distintas.get('PAGO DE CONSULTORIA')!.clave)
      .not.toBe(distintas.get('PAGO DE CONSULTORIA MENSUAL')!.clave);

    const juntas = agruparAsuntos(entradas, 0.3);
    expect(juntas.get('PAGO DE CONSULTORIA')!.clave)
      .toBe(juntas.get('PAGO DE CONSULTORIA MENSUAL')!.clave);
  });

  it('suma en el líder los expedientes de toda su familia', () => {
    const familias = agruparAsuntos(
      [entrada('PAGO DE CONSULTORIA', 100), entrada('PAGO DE CONSULTORIA MENSUAL', 20)],
      0.55,
    );
    expect(familias.get('PAGO DE CONSULTORIA')!.expedientes).toBe(120);
  });

  it('no falla con la lista vacía', () => {
    expect(agruparAsuntos([], 0.55).size).toBe(0);
  });
});

describe('claveDeProceso', () => {
  it('es estable para el mismo texto — de eso depende que el renombre manual sobreviva al refresco', () => {
    expect(claveDeProceso('PAGO DE CONSULTORIA')).toBe(claveDeProceso('PAGO DE CONSULTORIA'));
    expect(claveDeProceso('PAGO DE CONSULTORIA')).not.toBe(claveDeProceso('RENOVACION DE CARTA FIANZA'));
    expect(claveDeProceso('PAGO DE CONSULTORIA')).toMatch(/^[0-9a-f]{16}$/);
  });
});
