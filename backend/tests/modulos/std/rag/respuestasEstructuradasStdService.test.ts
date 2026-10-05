jest.mock('../../../../src/compartido/config/appDatabase', () => ({ appSequelize: { query: jest.fn() } }));
jest.mock('../../../../src/modulos/std/config/stdRagDatabase', () => ({ stdRagSequelize: { query: jest.fn() } }));
jest.mock('../../../../src/modulos/sgd/config/database', () => ({ DB_SCHEMA: 'sgd', sequelize: { query: jest.fn() } }));
jest.mock('../../../../src/compartido/rag/configService', () => ({ leerNumero: jest.fn(), leerConfig: jest.fn() }));

import {
  agruparMovimientos,
  normalizarContratoStd,
  ordenarParaUltimo,
  textoParticipantesStd,
  textoUltimoDocumentoStd,
  type TarjetaDocumentoStd,
} from '../../../../src/modulos/std/rag/respuestasEstructuradasStdService';
import { esMetaListadoStd, resumenTablaStd } from '../../../../src/modulos/std/rag/listadoChatStdService';
import type { MovimientoStd } from '../../../../src/modulos/std/services/stdConsultasService';

const cand = (id: number, over: Partial<{ n: 1 | 2; t: number; j: number }> = {}) =>
  ({ a: String(id), s: '', n: 1 as 1 | 2, dm: 1, dc: 0, r: false, t: 1, bm: 1, bc: 0, ...over });

describe('ordenarParaUltimo', () => {
  it('más términos primero; luego directos o "juntos"; luego el más reciente', () => {
    const fechas = new Map([[1, '2026-04-20'], [2, '2026-05-01'], [3, '2026-01-01'], [4, '2026-06-01']]);
    const orden = ordenarParaUltimo([
      cand(1, { t: 2 }),
      cand(2, { t: 2, n: 2 }),          // más reciente, pero solo en contenido y sin "juntos"
      cand(3, { t: 2, n: 2, j: 1 }),    // juntos: cuenta como evidencia fuerte
      cand(4, { t: 1 }),                // el más reciente de todos, pero cumple menos términos
    ], fechas);
    expect(orden.map((c) => c.a)).toEqual(['1', '3', '2', '4']);
  });
});

describe('agruparMovimientos', () => {
  const mov = (id: number, origen: string | null, areaO: string | null, destino: string | null, areaD: string | null): MovimientoStd => ({
    id_documento: id, id_documento_mov: 0, fecha: null, area_origen: areaO, origen, area_destino: areaD, destino,
    accion: null, estado: null, observacion: null, copia: 0,
  });

  it('cuenta derivaciones y documentos distintos por persona/área, más documentos primero', () => {
    const r = agruparMovimientos([
      mov(1, 'PINEDO', 'OGI', 'KIKUCHI', 'OGI'),
      mov(1, 'PINEDO', 'OGI', 'PAREDES', 'UEPO-OGI'),
      mov(2, 'PINEDO', 'OGI', 'KIKUCHI', 'OGI'),
      mov(3, 'ECHANDIA', null, null, 'UAU'),
    ]);
    expect(r.emisores[0]).toEqual({ dependencia: 'OGI', empleado: 'PINEDO', documentos: 3, expedientes: 2 });
    expect(r.emisores[1]).toEqual({ dependencia: null, empleado: 'ECHANDIA', documentos: 1, expedientes: 1 });
    expect(r.destinatarios[0]).toEqual({ dependencia: 'OGI', persona: 'KIKUCHI', veces: 2, expedientes: 2 });
    // Un área sin persona (destino genérico) también es destinatario.
    expect(r.destinatarios).toContainEqual({ dependencia: 'UAU', persona: null, veces: 1, expedientes: 1 });
  });
});

describe('normalizarContratoStd', () => {
  it('quita espacios y ceros a la izquierda, en mayúsculas', () => {
    expect(normalizarContratoStd('0227 - 2022-mcebs')).toBe('227-2022-MCEBS');
    expect(normalizarContratoStd('Contrato N° 083-2024-MCEBS (adenda)')).toBe('83-2024-MCEBS');
    expect(normalizarContratoStd('sin número')).toBeNull();
    expect(normalizarContratoStd(null)).toBeNull();
  });
});

describe('textos del STD', () => {
  const doc = {
    nuAnnExp: '61279', nuSecExp: null, numeroExpediente: 'STD 61279', nuAnn: 'STD', nuEmi: '349366',
    titulo: 'CARTA N°116-2026-CSMAYOLO', asunto: 'x', fecha: '2026-04-20', emisor: null, remitente: 'ECHANDIA',
    terminosCoinciden: 1, totalTerminos: 2, indicaciones: [], anteriores: [],
  } as TarjetaDocumentoStd;

  it('último documento: ámbito, N° STD, fecha y aviso de términos parciales', () => {
    const t = textoUltimoDocumentoStd({ total: 125, terminos: ['227-2022-MCEBS', 'penalidad'], ambito: 'busqueda' }, doc);
    expect(t).toBe('El documento más reciente entre los 125 documentos relacionados con «227-2022-MCEBS» + «penalidad» es '
      + 'CARTA N°116-2026-CSMAYOLO (STD 61279) del 20/04/2026. Ojo: no cumple todos los términos (1 de 2).');
  });

  it('del listado anterior y de toda la base', () => {
    expect(textoUltimoDocumentoStd({ total: 962, terminos: [], ambito: 'conjunto' }, { ...doc, totalTerminos: 0 }))
      .toContain('entre los 962 documentos del listado anterior');
    expect(textoUltimoDocumentoStd({ total: 3, terminos: ['Puno'], ambito: 'busqueda', fueraDelConjunto: true }, { ...doc, totalTerminos: 1 }))
      .toContain('de toda la base (ninguno del listado anterior cumplía)');
  });

  it('participantes: cuenta cada grupo y avisa el tope de 200', () => {
    const t = textoParticipantesStd({ total: 962, terminos: ['227-2022-MCEBS'], ambito: 'busqueda' }, {
      totalExpedientes: 962, remitentes: [{ nombre: 'A', documento: null, documentos: 1, expedientes: 1 }],
      emisores: [], destinatarios: [], tramites: [],
    });
    expect(t).toContain('(sobre los 200 más relevantes)');
    expect(t).toContain('1 remitente, 0 personas o áreas que derivaron y 0 destinatarios');
  });
});

describe('meta del listado STD', () => {
  const meta = {
    version: 1 as const, sistema: 'std' as const, plan: {} as never,
    busqueda: { total: 23, nivel1: 20, nivel2: 3, modoTerminos: 'todos' as const, terminos: ['x'], sinExpediente: 0, truncado: false },
    documentos: Array.from({ length: 23 }, (_, i) => cand(i + 1)),
  };

  it('reconoce solo la meta del STD (no la de un listado del SGD)', () => {
    expect(esMetaListadoStd(meta)).toBe(true);
    expect(esMetaListadoStd({ ...meta, sistema: undefined })).toBe(false);
    expect(esMetaListadoStd({ version: 1, expedientes: [], busqueda: {} })).toBe(false);
    expect(esMetaListadoStd(null)).toBe(false);
  });

  it('el resumen del historial no trae filas y avisa que hay qué cargar', () => {
    expect(resumenTablaStd(meta)).toEqual({ filas: [], pagina: 0, porPagina: 10, total: 23, nivel1: 20, nivel2: 3, hayMas: true });
  });
});
