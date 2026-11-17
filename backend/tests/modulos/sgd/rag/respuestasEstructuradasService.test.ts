jest.mock('../../../../src/compartido/config/appDatabase', () => ({ appSequelize: { query: jest.fn() } }));
jest.mock('../../../../src/modulos/sgd/config/database', () => ({ DB_SCHEMA: 'sgd', sequelize: { query: jest.fn() } }));
jest.mock('../../../../src/compartido/rag/configService', () => ({ leerNumero: jest.fn() }));

import { tipoContrato } from '../../../../src/modulos/sgd/rag/consultasExpedienteService';
import {
  agruparPorContrato,
  textoGrupos,
  textoParticipantes,
  textoUltimoDocumento,
  type BloqueParticipantes,
  type TarjetaDocumento,
} from '../../../../src/modulos/sgd/rag/respuestasEstructuradasService';

const fila = (sec: string, archivado = false) => ({
  nuAnnExp: '2026', nuSecExp: sec, numeroExpediente: `2026-${sec}`, archivado, ultimoMovimiento: '2026-09-01',
});

describe('agruparPorContrato', () => {
  const contratos = new Map([
    ['2026|1', ['341-2025-MCEBS', '109-2026-MCEBS']],
    ['2026|2', ['341-2025-MCEBS']],
    ['2026|3', ['352-2025-MCEBS']],
    ['2026|4', ['999-2020-MCEBS']],
    ['2026|5', ['218-2024-MCEBS']],
  ]);
  const nombres = new Map([
    ['341-2025-MCEBS', { nombre: 'Laboratorios de Camélidos – Puno', menciones: 125 }],
    ['352-2025-MCEBS', { nombre: 'Instituto de Medicina Tropical', menciones: 248 }],
    ['218-2024-MCEBS', { nombre: 'Consultoría de evaluación', menciones: 4 }],
  ]);

  it('cada expediente va UNA vez, al grupo de su contrato más citado', () => {
    const grupos = agruparPorContrato(['1', '2', '3', '4', '5', '6'].map((s) => fila(s)), contratos, nombres);

    const todos = grupos.flatMap((g) => g.expedientes.map((e) => e.numero));
    expect(todos.sort()).toEqual(['2026-1', '2026-2', '2026-3', '2026-4', '2026-5', '2026-6']);
    expect(grupos[0]).toMatchObject({ contrato: '341-2025-MCEBS', nombre: 'Laboratorios de Camélidos – Puno', dudoso: false });
    expect(grupos[0].expedientes.map((e) => e.numero)).toEqual(['2026-1', '2026-2']);
    // "Sin contrato" siempre al final.
    expect(grupos.at(-1)).toMatchObject({ contrato: null, expedientes: [{ numero: '2026-6' }] });
  });

  it('marca como dudoso el nombre con pocas menciones y fusiona contratos del mismo proyecto', () => {
    const mismos = new Map([...nombres, ['109-2026-MCEBS', { nombre: 'Laboratorios de Camélidos - Puno', menciones: 48 }]]);
    const c = new Map([['2026|1', ['341-2025-MCEBS']], ['2026|2', ['109-2026-MCEBS']], ['2026|5', ['218-2024-MCEBS']]]);

    const grupos = agruparPorContrato([fila('1'), fila('2'), fila('5')], c, mismos);

    expect(grupos).toHaveLength(2);
    expect(grupos[0].expedientes).toHaveLength(2);
    expect(grupos.find((g) => g.contrato === '218-2024-MCEBS')?.dudoso).toBe(true);
  });
});

describe('agruparPorContrato — tipo de contrato', () => {
  it('obras primero, luego lo no clasificado, luego consultorías y servicios', () => {
    const c = new Map([['2026|1', ['93-2026-MCEBS']], ['2026|2', ['1-2020-X']], ['2026|3', ['352-2025-MCEBS']], ['2026|4', ['5-2020-X']]]);
    const n = new Map([
      ['93-2026-MCEBS', { nombre: 'Especialista temático', menciones: 21, tipo: 'consultoria' as const }],
      ['1-2020-X', { nombre: 'Algo', menciones: 30, tipo: null }],
      ['352-2025-MCEBS', { nombre: 'Medicina Tropical', menciones: 248, tipo: 'obra' as const }],
    ]);
    const grupos = agruparPorContrato(['1', '2', '3', '4'].map((s) => fila(s)), c, n);
    expect(grupos.map((g) => g.contrato)).toEqual(['352-2025-MCEBS', '1-2020-X', '5-2020-X', '93-2026-MCEBS']);
  });
});

describe('tipoContrato', () => {
  it('primero por el texto previo al nombre', () => {
    expect(tipoContrato(', para la ejecución de la obra ')).toBe('obra');
    expect(tipoContrato(', Consultoría Individual: ')).toBe('consultoria');
    expect(tipoContrato(' para la adquisición de ')).toBe('adquisicion');
  });

  it('si el texto previo no dice nada, por cómo empieza el nombre', () => {
    expect(tipoContrato(' ', 'SERVICIO DE CONSULTORÍA PARA EL DISEÑO')).toBe('consultoria');
    expect(tipoContrato(null, 'Adquisición de equipos variados')).toBe('adquisicion');
    expect(tipoContrato(null, 'Mejoramiento de los servicios de educación superior')).toBe('obra');
    expect(tipoContrato(null, 'Pronunciamiento')).toBeNull();
  });
});

describe('textoGrupos', () => {
  it('nombra el tipo cuando no es una obra', () => {
    const t = textoGrupos([
      { contrato: '93-2026-MCEBS', nombre: 'Especialista temático', tipo: 'consultoria', dudoso: false, expedientes: [{ numero: 'A', archivado: false, ultimoMovimiento: null }] },
      { contrato: '343-2025-MCEBS', nombre: 'Equipos variados', tipo: 'adquisicion', dudoso: false, expedientes: [{ numero: 'B', archivado: true, ultimoMovimiento: null }] },
    ]);
    expect(t.split('\n')).toEqual([
      '- Consultoría «Especialista temático» (contrato 93-2026-MCEBS): A (en trámite)',
      '- Adquisición «Equipos variados» (contrato 343-2025-MCEBS): B (archivado)',
    ]);
  });

  it('una viñeta por grupo con estado de cada expediente', () => {
    const t = textoGrupos([
      { contrato: '341-2025-MCEBS', nombre: 'Laboratorios', dudoso: false, expedientes: [{ numero: 'A', archivado: false, ultimoMovimiento: null }] },
      { contrato: '218-2024-MCEBS', nombre: 'Consultoría', dudoso: true, expedientes: [{ numero: 'B', archivado: true, ultimoMovimiento: null }] },
      { contrato: '999-2020-MCEBS', nombre: null, dudoso: false, expedientes: [{ numero: 'C', archivado: false, ultimoMovimiento: null }] },
      { contrato: null, nombre: null, dudoso: false, expedientes: [{ numero: 'D', archivado: false, ultimoMovimiento: null }] },
    ]);
    expect(t.split('\n')).toEqual([
      '- Laboratorios (contrato 341-2025-MCEBS): A (en trámite)',
      '- Consultoría (contrato 218-2024-MCEBS, nombre no confirmado): B (archivado)',
      '- Contrato 999-2020-MCEBS (sin nombre de proyecto identificado): C (en trámite)',
      '- Sin contrato identificado: D (en trámite)',
    ]);
  });
});

describe('textos de último documento y participantes', () => {
  const doc: TarjetaDocumento = {
    nuAnn: '2026', nuEmi: '1', nuAnnExp: '2026', nuSecExp: '9', numeroExpediente: 'OPPMC020260000089',
    titulo: 'INFORME TECNICO N° 5', asunto: 'x', fecha: '2026-09-25', emisor: 'OPPMC-UI · CAMACHO', remitente: null,
    terminosCoinciden: 1, totalTerminos: 2, indicaciones: [], anteriores: [],
  };

  it('último documento: ámbito, fecha, expediente y aviso de términos parciales', () => {
    const t = textoUltimoDocumento({ total: 58, terminos: ['controversia', 'Huancavelica'], ambito: 'busqueda' }, doc);
    expect(t).toContain('El documento más reciente entre los 58 expedientes relacionados con «controversia» + «Huancavelica» es INFORME TECNICO N° 5 del 25/09/2026, en el expediente OPPMC020260000089.');
    expect(t).toContain('este cumple 1 de 2');
    expect(t).toContain('No registra derivaciones.');
  });

  it('en modo expediente no repite el número de expediente', () => {
    const t = textoUltimoDocumento({ total: 1, terminos: [], ambito: 'expediente' }, { ...doc, totalTerminos: 0 });
    expect(t).toMatch(/^El documento más reciente en este expediente es INFORME TECNICO N° 5 del 25\/09\/2026\./);
    expect(t).not.toContain('OPPMC020260000089');
  });

  it('participantes: cuenta cada grupo y avisa el tope', () => {
    const b: BloqueParticipantes = {
      totalExpedientes: 128,
      remitentes: Array(25).fill({ nombre: 'X', documento: null, documentos: 1, expedientes: 1 }),
      emisores: [{ dependencia: 'OAL', empleado: 'A', documentos: 2, expedientes: 1 }],
      destinatarios: [],
      tramites: [{ nuAnnExp: '2026', nuSecExp: '1', numeroExpediente: 'N', movimientos: [] }],
    };
    const t = textoParticipantes({ total: 128, terminos: ['controversia'], ambito: 'busqueda' }, b);
    expect(t).toContain('25 remitentes externos, 1 emisor interno, 0 destinatarios');
    expect(t).toContain('se muestran los 25 más frecuentes');
    expect(t).toContain('ese expediente');
  });
});
