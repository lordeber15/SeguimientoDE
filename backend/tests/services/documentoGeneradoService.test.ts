import type { DatosDocumentoGenerado } from '../../src/services/documentoService';
import { datosAMarkdown, esGenerable } from '../../src/services/documentoGeneradoService';

function datos(sobrescribir: Partial<DatosDocumentoGenerado> = {}): DatosDocumentoGenerado {
  return {
    coTipDoc: '232',
    tipoDocumento: 'PROVEIDO',
    numeroDocumento: '000014-2026-OGA',
    numeroExpediente: '2026-0000324',
    asunto: 'DOCUMENTACION NECESARIA PARA EL PAGO',
    fechaEmision: '24/08/2026',
    diasAtencion: 3,
    dependenciaEmisora: 'OFICINA GENERAL DE ADMINISTRACION',
    empleadoEmisor: 'LOPEZ HERENCIA GERMAN',
    siglaInstitucion: 'UE118',
    destinos: [
      {
        nuDes: 1,
        dependencia: 'UNIDAD DE LOGISTICA',
        persona: 'VICENTE VICENTE MARCIA MILAGROS',
        tramite: 'ATENDER',
        prioridad: 'NORMAL',
        indicaciones: 'Revisar y remitir',
      },
    ],
    referencias: [{ documento: 'INFORME N° 000712-2026-OGA', asunto: 'Solicitud de conformidad' }],
    ...sobrescribir,
  };
}

describe('esGenerable', () => {
  it.each([
    ['PROVEÍDO', '232'],
    ['HOJA DE ENVÍO', '304'],
  ])('reconoce %s', (_caso, codigo) => {
    expect(esGenerable(codigo)).toBe(true);
  });

  it.each([['INFORME', '003'], ['nulo', null], ['vacío', '']])(
    'no reconoce %s',
    (_caso, codigo) => {
      expect(esGenerable(codigo)).toBe(false);
    },
  );

  it('tolera espacios alrededor del código', () => {
    expect(esGenerable(' 232 ')).toBe(true);
  });
});

describe('datosAMarkdown', () => {
  it('lleva el título, los datos generales, el asunto, las referencias y los destinos', () => {
    const md = datosAMarkdown(datos());

    // El título canónico sale de TITULOS (con tilde), no del `tipoDocumento` crudo del SGD.
    expect(md).toContain('# PROVEÍDO N° 000014-2026-OGA');
    expect(md).toContain('- **Expediente:** 2026-0000324');
    expect(md).toContain('- **Fecha de emisión:** 24/08/2026');
    expect(md).toContain('- **Emitido por:** LOPEZ HERENCIA GERMAN');
    expect(md).toContain('- **Plazo de atención:** 3 días');
    expect(md).toContain('## Asunto');
    expect(md).toContain('DOCUMENTACION NECESARIA PARA EL PAGO');
    expect(md).toContain('## Referencias');
    expect(md).toContain('- INFORME N° 000712-2026-OGA — Solicitud de conformidad');
    expect(md).toContain('## Destinos');
    expect(md).toContain('| UNIDAD DE LOGISTICA | VICENTE VICENTE MARCIA MILAGROS | ATENDER | NORMAL | Revisar y remitir |');
  });

  it('usa el título del tipo 304 cuando es una hoja de envío', () => {
    const md = datosAMarkdown(datos({ coTipDoc: '304', tipoDocumento: 'HOJA DE ENVIO' }));
    expect(md).toContain('# HOJA DE ENVÍO N° 000014-2026-OGA');
  });

  it('omite las secciones vacías en vez de dejar encabezados huérfanos', () => {
    const md = datosAMarkdown(
      datos({ asunto: '   ', referencias: [], destinos: [], diasAtencion: null }),
    );

    expect(md).not.toContain('## Asunto');
    expect(md).not.toContain('## Referencias');
    expect(md).not.toContain('## Destinos');
    expect(md).not.toContain('Plazo de atención');
    // El título canónico sale de TITULOS (con tilde), no del `tipoDocumento` crudo del SGD.
    expect(md).toContain('# PROVEÍDO N° 000014-2026-OGA');
  });

  it('escapa las barras verticales para que no rompan la fila de la tabla', () => {
    const md = datosAMarkdown(
      datos({
        destinos: [
          {
            nuDes: 1,
            dependencia: 'AREA A | AREA B',
            persona: null,
            tramite: 'ATENDER',
            prioridad: 'NORMAL',
            indicaciones: 'Primera línea\nSegunda línea',
          },
        ],
      }),
    );

    const fila = md.split('\n').find((l) => l.includes('AREA A'))!;
    expect(fila).toContain('AREA A \\| AREA B');
    // El salto de línea se aplana: si no, partiría la fila en dos y rompería la tabla.
    expect(fila).toContain('Primera línea Segunda línea');
    // Cinco columnas ⇒ seis separadores reales, ni uno más pese a los `|` del contenido.
    const separadores = fila.replace(/\\\|/g, '').split('|').length - 1;
    expect(separadores).toBe(6);
    // Los huecos se marcan, no se dejan en blanco.
    expect(fila).toContain('| — |');
  });

  it('no deja líneas en blanco al final ni al principio', () => {
    const md = datosAMarkdown(datos());
    expect(md.startsWith('# ')).toBe(true);
    expect(md.endsWith('\n')).toBe(true);
    expect(md.endsWith('\n\n')).toBe(false);
  });
});
