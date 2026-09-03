import type { Request, Response } from 'express';

jest.mock('../../src/rag/ingestaService', () => ({
  ...jest.requireActual('../../src/rag/ingestaService'),
  iniciarJobConversion: jest.fn(),
  iniciarJobEmbedding: jest.fn(),
  iniciarJobReparacion: jest.fn(),
  repararDocumento: jest.fn(),
  pausarJob: jest.fn(),
  reanudarJob: jest.fn(),
  cancelarJob: jest.fn(),
  estadoJob: jest.fn(),
}));

jest.mock('../../src/rag/estadoService', () => ({
  ...jest.requireActual('../../src/rag/estadoService'),
  listarDocumentos: jest.fn(),
  markdownDocumento: jest.fn(),
}));

jest.mock('../../src/rag/visionService', () => ({
  transcribirDocumento: jest.fn(),
}));

import { ErrorIA } from '../../src/ai/types';
import {
  getDocumentos,
  getMarkdownDocumento,
  postCancelarJob,
  postExtraerVision,
  postIngestaConversion,
  postIngestaEmbedding,
  postIngestaReparacion,
  postPausarJob,
  postReanudarJob,
  postReintentarDocumento,
} from '../../src/controllers/ragController';
import { listarDocumentos, markdownDocumento } from '../../src/rag/estadoService';
import {
  cancelarJob,
  estadoJob,
  iniciarJobConversion,
  iniciarJobEmbedding,
  iniciarJobReparacion,
  pausarJob,
  reanudarJob,
  repararDocumento,
} from '../../src/rag/ingestaService';
import { transcribirDocumento } from '../../src/rag/visionService';

const mockConversion = iniciarJobConversion as jest.Mock;
const mockEmbedding = iniciarJobEmbedding as jest.Mock;
const mockReparacion = iniciarJobReparacion as jest.Mock;
const mockRepararDocumento = repararDocumento as jest.Mock;
const mockPausarJob = pausarJob as jest.Mock;
const mockReanudarJob = reanudarJob as jest.Mock;
const mockCancelarJob = cancelarJob as jest.Mock;
const mockEstadoJob = estadoJob as jest.Mock;
const mockListarDocumentos = listarDocumentos as jest.Mock;
const mockMarkdownDocumento = markdownDocumento as jest.Mock;
const mockTranscribirDocumento = transcribirDocumento as jest.Mock;

function fakeResponse() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  } as unknown as Response;
}

function fakeRequest(body: unknown) {
  return { body, usuario: { codUser: 'u1' } } as unknown as Request;
}

// Solo se prueba `postIngestaConversion`: ambos handlers comparten exactamente el mismo
// `filtroDeBody`, así que un segundo describe repitiendo los mismos casos sobre
// `postIngestaEmbedding` no añadiría cobertura real — se deja un único test cruzado al final
// para confirmar que también pasa por el mismo blindaje.
describe('postIngestaConversion — blindaje del filtro por expediente', () => {
  beforeEach(() => jest.clearAllMocks());

  it('con nuAnnExp y nuSecExp válidos, los pasa normalizados (nuSecExp a 10 dígitos)', async () => {
    mockConversion.mockResolvedValue({ jobId: 7 });
    const res = fakeResponse();

    await postIngestaConversion(fakeRequest({ nuAnnExp: '2026', nuSecExp: '58' }), res);

    expect(mockConversion).toHaveBeenCalledWith(
      { nuAnnExp: '2026', nuSecExp: '0000000058', limite: undefined },
      'u1',
    );
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith({ jobId: 7 });
  });

  it('sin nuAnnExp ni nuSecExp, deja el filtro vacío (ingesta global sigue funcionando)', async () => {
    mockConversion.mockResolvedValue({ jobId: 1 });
    const res = fakeResponse();

    await postIngestaConversion(fakeRequest({}), res);

    expect(mockConversion).toHaveBeenCalledWith(
      { nuAnnExp: undefined, nuSecExp: undefined, limite: undefined },
      'u1',
    );
    expect(res.status).toHaveBeenCalledWith(202);
  });

  it.each([
    ['solo nuAnnExp', { nuAnnExp: '2026' }],
    ['solo nuSecExp', { nuSecExp: '0000000058' }],
    ['nuSecExp vacío junto a nuAnnExp', { nuAnnExp: '2026', nuSecExp: '' }],
  ])(
    'con %s, devuelve 400 y NUNCA llega a iniciar un job (evita que el filtro se desactive y ' +
      'el job procese todo el corpus)',
    async (_caso, body) => {
      const res = fakeResponse();

      await postIngestaConversion(fakeRequest(body), res);

      expect(mockConversion).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    },
  );

  it('con año o secuencia de formato inválido, devuelve 400', async () => {
    const res = fakeResponse();

    await postIngestaConversion(fakeRequest({ nuAnnExp: 'abcd', nuSecExp: '58' }), res);

    expect(mockConversion).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it.each([
    ['limite: 0', { limite: 0 }],
    ['limite negativo', { limite: -1 }],
    ['limite no numérico', { limite: 'abc' }],
    ['limite decimal', { limite: 1.5 }],
  ])('con %s, devuelve 400 en vez de un LIMIT inválido o NaN', async (_caso, extra) => {
    const res = fakeResponse();

    await postIngestaConversion(fakeRequest(extra), res);

    expect(mockConversion).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('con limite entero positivo, lo pasa tal cual', async () => {
    mockConversion.mockResolvedValue({ jobId: 2 });
    const res = fakeResponse();

    await postIngestaConversion(fakeRequest({ limite: 250 }), res);

    expect(mockConversion).toHaveBeenCalledWith({ nuAnnExp: undefined, nuSecExp: undefined, limite: 250 }, 'u1');
  });

  it('mapea ErrorIA (proveedor caído/mal configurado) a 409 con el motivo, no a 500 genérico', async () => {
    mockConversion.mockRejectedValue(new ErrorIA('ollama: el servicio no responde', 'unavailable', 'ollama'));
    const res = fakeResponse();

    await postIngestaConversion(fakeRequest({}), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ message: 'ollama: el servicio no responde' });
  });
});

describe('postIngestaConversion — filtro por documentoIds (modal de indexación del chat)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('con un arreglo de ids válido, lo pasa normalizado a número', async () => {
    mockConversion.mockResolvedValue({ jobId: 11 });
    const res = fakeResponse();

    await postIngestaConversion(fakeRequest({ documentoIds: ['42', 43] }), res);

    expect(mockConversion).toHaveBeenCalledWith(
      { nuAnnExp: undefined, nuSecExp: undefined, documentoIds: [42, 43], limite: undefined },
      'u1',
    );
    expect(res.status).toHaveBeenCalledWith(202);
  });

  it('se combina con nuAnnExp/nuSecExp cuando ambos llegan', async () => {
    mockConversion.mockResolvedValue({ jobId: 12 });
    const res = fakeResponse();

    await postIngestaConversion(fakeRequest({ nuAnnExp: '2026', nuSecExp: '58', documentoIds: [1] }), res);

    expect(mockConversion).toHaveBeenCalledWith(
      { nuAnnExp: '2026', nuSecExp: '0000000058', documentoIds: [1], limite: undefined },
      'u1',
    );
  });

  it.each([
    ['arreglo vacío', []],
    ['no es un arreglo', 'no-es-arreglo'],
    ['tiene un id no entero', [1, 'abc']],
    ['tiene un id negativo', [1, -3]],
  ])('con documentoIds inválido (%s), devuelve 400 y NUNCA llega a iniciar un job', async (_caso, valor) => {
    const res = fakeResponse();

    await postIngestaConversion(fakeRequest({ documentoIds: valor }), res);

    expect(mockConversion).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('con más de 500 ids, devuelve 400 — evita jobs sin tope real', async () => {
    const res = fakeResponse();

    await postIngestaConversion(fakeRequest({ documentoIds: Array.from({ length: 501 }, (_, i) => i + 1) }), res);

    expect(mockConversion).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('postIngestaEmbedding — comparte el mismo blindaje', () => {
  beforeEach(() => jest.clearAllMocks());

  it('con nuSecExp sin nuAnnExp, devuelve 400 y no inicia el job', async () => {
    const res = fakeResponse();

    await postIngestaEmbedding(fakeRequest({ nuSecExp: '0000000058' }), res);

    expect(mockEmbedding).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('postIngestaReparacion — comparte el mismo blindaje que conversión y embeddings', () => {
  beforeEach(() => jest.clearAllMocks());

  it('con filtro válido, inicia el job y responde 202', async () => {
    mockReparacion.mockResolvedValue({ jobId: 42 });
    const res = fakeResponse();

    await postIngestaReparacion(fakeRequest({}), res);

    expect(mockReparacion).toHaveBeenCalledWith({ nuAnnExp: undefined, nuSecExp: undefined, limite: undefined }, 'u1');
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith({ jobId: 42 });
  });

  it('con nuSecExp sin nuAnnExp, devuelve 400 y no inicia el job', async () => {
    const res = fakeResponse();

    await postIngestaReparacion(fakeRequest({ nuSecExp: '0000000058' }), res);

    expect(mockReparacion).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('cuando no hay nada recuperable, propaga el 404 del servicio', async () => {
    const { IngestaError } = jest.requireActual('../../src/rag/ingestaService');
    mockReparacion.mockRejectedValue(new IngestaError('No hay documentos recuperables con ese filtro', 404));
    const res = fakeResponse();

    await postIngestaReparacion(fakeRequest({}), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: 'No hay documentos recuperables con ese filtro' });
  });
});

describe('postReintentarDocumento', () => {
  beforeEach(() => jest.clearAllMocks());

  function fakeParams(id: string) {
    return { params: { id } } as unknown as Request;
  }

  it('con id válido, responde 200 con la fila reparada', async () => {
    const documento = { id: 42, estado: 'convertido' };
    mockRepararDocumento.mockResolvedValue({ documento });
    const res = fakeResponse();

    await postReintentarDocumento(fakeParams('42'), res);

    expect(mockRepararDocumento).toHaveBeenCalledWith(42);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ documento });
  });

  it('responde 202 cuando la conversión sigue en curso tras el tiempo de espera', async () => {
    const documento = { id: 42, estado: 'en_proceso' };
    mockRepararDocumento.mockResolvedValue({ documento, enCurso: true });
    const res = fakeResponse();

    await postReintentarDocumento(fakeParams('42'), res);

    expect(res.status).toHaveBeenCalledWith(202);
  });

  it('devuelve 400 con un id no numérico, sin llamar al servicio', async () => {
    const res = fakeResponse();

    await postReintentarDocumento(fakeParams('abc'), res);

    expect(mockRepararDocumento).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('propaga el 409 del servicio (bloqueado, en cola de otro job, o circuito abierto)', async () => {
    const { IngestaError } = jest.requireActual('../../src/rag/ingestaService');
    mockRepararDocumento.mockRejectedValue(new IngestaError('Este documento se está procesando ahora mismo', 409));
    const res = fakeResponse();

    await postReintentarDocumento(fakeParams('42'), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ message: 'Este documento se está procesando ahora mismo' });
  });
});

describe('postExtraerVision', () => {
  beforeEach(() => jest.clearAllMocks());

  function fakeParams(id: string) {
    return { params: { id } } as unknown as Request;
  }

  it('con id válido, responde 200 con la fila transcrita', async () => {
    const documento = { id: 42, estado: 'convertido', metodo: 'vision' };
    mockTranscribirDocumento.mockResolvedValue(documento);
    const res = fakeResponse();

    await postExtraerVision(fakeParams('42'), res);

    expect(mockTranscribirDocumento).toHaveBeenCalledWith(42);
    expect(res.json).toHaveBeenCalledWith({ documento });
  });

  it('devuelve 400 con un id no numérico, sin llamar al servicio', async () => {
    const res = fakeResponse();

    await postExtraerVision(fakeParams('abc'), res);

    expect(mockTranscribirDocumento).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('propaga el 409 del servicio (sin clave, generable, tipo no admitido, techo diario…)', async () => {
    const { IngestaError } = jest.requireActual('../../src/rag/ingestaService');
    mockTranscribirDocumento.mockRejectedValue(
      new IngestaError('OPENAI_API_KEY: Necesaria para la extracción de texto con IA (visión).', 409),
    );
    const res = fakeResponse();

    await postExtraerVision(fakeParams('42'), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      message: 'OPENAI_API_KEY: Necesaria para la extracción de texto con IA (visión).',
    });
  });

  it('propaga el 404 cuando el documento ya no existe', async () => {
    const { IngestaError } = jest.requireActual('../../src/rag/ingestaService');
    mockTranscribirDocumento.mockRejectedValue(new IngestaError('El documento ya no existe en rag.documento', 404));
    const res = fakeResponse();

    await postExtraerVision(fakeParams('999'), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});

function fakeQuery(query: Record<string, unknown>) {
  return { query } as unknown as Request;
}

describe('getDocumentos', () => {
  beforeEach(() => jest.clearAllMocks());

  it('pasa los filtros y paddea nuSecExp a 10 dígitos', async () => {
    mockListarDocumentos.mockResolvedValue({ total: 0, pagina: 1, porPagina: 50, items: [] });
    const res = fakeResponse();

    await getDocumentos(
      fakeQuery({ estado: 'sin_texto', q: 'proveido', nuAnnExp: '2026', nuSecExp: '58', pagina: '2' }),
      res,
    );

    expect(mockListarDocumentos).toHaveBeenCalledWith({
      estado: 'sin_texto',
      q: 'proveido',
      nuAnnExp: '2026',
      nuSecExp: '0000000058',
      jobId: undefined,
      pagina: 2,
      porPagina: undefined,
    });
    expect(res.json).toHaveBeenCalledWith({ total: 0, pagina: 1, porPagina: 50, items: [] });
  });

  it('funciona sin ningún filtro (lista completa)', async () => {
    mockListarDocumentos.mockResolvedValue({ total: 3, pagina: 1, porPagina: 50, items: [] });
    const res = fakeResponse();

    await getDocumentos(fakeQuery({}), res);

    expect(mockListarDocumentos).toHaveBeenCalledWith({
      estado: undefined, q: undefined, nuAnnExp: undefined, nuSecExp: undefined,
      jobId: undefined, pagina: undefined, porPagina: undefined,
    });
    expect(mockListarDocumentos).toHaveBeenCalledTimes(1);
  });

  it('devuelve 400 si nuSecExp viene sin nuAnnExp con formato inválido', async () => {
    const res = fakeResponse();

    await getDocumentos(fakeQuery({ nuAnnExp: '26' }), res);

    expect(mockListarDocumentos).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('devuelve 400 si "pagina" no es un entero positivo', async () => {
    const res = fakeResponse();

    await getDocumentos(fakeQuery({ pagina: '0' }), res);

    expect(mockListarDocumentos).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('devuelve 400 si el estado no es válido (RangeError del servicio)', async () => {
    mockListarDocumentos.mockRejectedValue(new RangeError('Estado inválido: abc'));
    const res = fakeResponse();

    await getDocumentos(fakeQuery({ estado: 'abc' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: 'Estado inválido: abc' });
  });

  it('pasa jobId cuando viene en la query, para acotar a los documentos de ese trabajo', async () => {
    mockListarDocumentos.mockResolvedValue({ total: 500, pagina: 1, porPagina: 50, items: [] });
    const res = fakeResponse();

    await getDocumentos(fakeQuery({ jobId: '23' }), res);

    expect(mockListarDocumentos).toHaveBeenCalledWith({
      estado: undefined, q: undefined, nuAnnExp: undefined, nuSecExp: undefined,
      jobId: 23, pagina: undefined, porPagina: undefined,
    });
  });

  it.each([['no numérico', 'abc'], ['cero', '0'], ['negativo', '-1']])(
    'devuelve 400 con jobId %s',
    async (_caso, valor) => {
      const res = fakeResponse();

      await getDocumentos(fakeQuery({ jobId: valor }), res);

      expect(mockListarDocumentos).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    },
  );
});

describe('getMarkdownDocumento', () => {
  beforeEach(() => jest.clearAllMocks());

  function fakeParams(id: string) {
    return { params: { id } } as unknown as Request;
  }

  it('devuelve el markdown cuando existe', async () => {
    mockMarkdownDocumento.mockResolvedValue({ markdown: '# Hola', chars: 6, metodo: 'markitdown', truncado: false });
    const res = fakeResponse();

    await getMarkdownDocumento(fakeParams('42'), res);

    expect(mockMarkdownDocumento).toHaveBeenCalledWith(42);
    expect(res.json).toHaveBeenCalledWith({ markdown: '# Hola', chars: 6, metodo: 'markitdown', truncado: false });
  });

  it('devuelve 404 si el documento no tiene markdown convertido todavía', async () => {
    mockMarkdownDocumento.mockResolvedValue(null);
    const res = fakeResponse();

    await getMarkdownDocumento(fakeParams('42'), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('devuelve 400 con un id no numérico', async () => {
    const res = fakeResponse();

    await getMarkdownDocumento(fakeParams('abc'), res);

    expect(mockMarkdownDocumento).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('postPausarJob / postReanudarJob / postCancelarJob', () => {
  beforeEach(() => jest.clearAllMocks());

  function fakeParamsJob(jobId: string) {
    return { params: { jobId } } as unknown as Request;
  }

  it('postPausarJob: con jobId válido, pausa y devuelve el estado actualizado', async () => {
    mockEstadoJob.mockResolvedValue({ id: 42, estado: 'pausado' });
    const res = fakeResponse();

    await postPausarJob(fakeParamsJob('42'), res);

    expect(mockPausarJob).toHaveBeenCalledWith(42);
    expect(res.json).toHaveBeenCalledWith({ id: 42, estado: 'pausado' });
  });

  it('postPausarJob: 400 con jobId no numérico, sin llamar al servicio', async () => {
    const res = fakeResponse();

    await postPausarJob(fakeParamsJob('abc'), res);

    expect(mockPausarJob).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('postPausarJob: propaga el 409 del servicio (job no está en curso)', async () => {
    const { IngestaError } = jest.requireActual('../../src/rag/ingestaService');
    mockPausarJob.mockRejectedValue(new IngestaError('El trabajo no está en curso', 409));
    const res = fakeResponse();

    await postPausarJob(fakeParamsJob('42'), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ message: 'El trabajo no está en curso' });
  });

  it('postReanudarJob: con jobId válido, reanuda y devuelve el estado actualizado', async () => {
    mockEstadoJob.mockResolvedValue({ id: 42, estado: 'en_curso' });
    const res = fakeResponse();

    await postReanudarJob(fakeParamsJob('42'), res);

    expect(mockReanudarJob).toHaveBeenCalledWith(42);
    expect(res.json).toHaveBeenCalledWith({ id: 42, estado: 'en_curso' });
  });

  it('postCancelarJob: con jobId válido, cancela y devuelve el estado actualizado', async () => {
    mockEstadoJob.mockResolvedValue({ id: 42, estado: 'cancelado' });
    const res = fakeResponse();

    await postCancelarJob(fakeParamsJob('42'), res);

    expect(mockCancelarJob).toHaveBeenCalledWith(42);
    expect(res.json).toHaveBeenCalledWith({ id: 42, estado: 'cancelado' });
  });

  it('postCancelarJob: 400 con jobId no numérico, sin llamar al servicio', async () => {
    const res = fakeResponse();

    await postCancelarJob(fakeParamsJob('xyz'), res);

    expect(mockCancelarJob).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
