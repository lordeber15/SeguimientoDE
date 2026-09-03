import type { Request, Response } from 'express';
import { actualizarPeso, listarPesos } from '../services/dashboardPesosService';
import {
  estadoResumen,
  refrescarResumen,
  RefrescoOcupado,
} from '../services/dashboardResumenService';
import {
  desempenoPorEmpleado,
  desempenoPorOficina,
  pendientesAntiguosPorOficina,
  tiposDocumento,
  type FiltroPendientes,
  type FiltroResumen,
} from '../services/dashboardService';

const FECHA_VALIDA = /^\d{4}-\d{2}-\d{2}$/;
const CODIGO_DEPENDENCIA_VALIDO = /^\d{1,5}$/;
/** Evita un rango explícito MAL PUESTO por error (ej. un año de más al tipear) — no limita una
 *  consulta global intencional (sin `desde` ni `hasta`), que corre contra el espejo local
 *  materializado (ver PLAN-DASHBOARD-DESEMPENO.md §5) y no es más cara que una acotada. */
const RANGO_MAXIMO_DIAS = 366;
const MS_POR_DIA = 24 * 60 * 60 * 1000;

interface RangoValido {
  desde?: string;
  hasta?: string;
}

/**
 * `desde`/`hasta` son cada uno OPCIONAL e INDEPENDIENTE (mismo criterio que `coDependencia`/
 * `tipoDocumento`) — sin ninguno de los dos, la consulta es sobre todo el histórico; con uno
 * solo, el rango queda abierto de ese lado. El chequeo de orden y el tope de `RANGO_MAXIMO_DIAS`
 * solo tienen sentido cuando AMBOS extremos están puestos (con uno solo no hay "duración" que
 * limitar).
 */
function validarRango(query: Request['query']): RangoValido | { error: string } {
  const desdeCruda = typeof query.desde === 'string' ? query.desde.trim() : '';
  const hastaCruda = typeof query.hasta === 'string' ? query.hasta.trim() : '';

  if (desdeCruda && !FECHA_VALIDA.test(desdeCruda)) {
    return { error: 'Si indica "desde", debe tener formato AAAA-MM-DD' };
  }
  if (hastaCruda && !FECHA_VALIDA.test(hastaCruda)) {
    return { error: 'Si indica "hasta", debe tener formato AAAA-MM-DD' };
  }

  const desde = desdeCruda || undefined;
  const hasta = hastaCruda || undefined;

  if (desde && Number.isNaN(new Date(`${desde}T00:00:00Z`).getTime())) {
    return { error: '"desde" no es una fecha válida' };
  }
  if (hasta && Number.isNaN(new Date(`${hasta}T00:00:00Z`).getTime())) {
    return { error: '"hasta" no es una fecha válida' };
  }

  if (desde && hasta) {
    const feDesde = new Date(`${desde}T00:00:00Z`);
    const feHasta = new Date(`${hasta}T00:00:00Z`);
    if (feDesde > feHasta) {
      return { error: '"desde" debe ser una fecha anterior o igual a "hasta"' };
    }

    const dias = Math.round((feHasta.getTime() - feDesde.getTime()) / MS_POR_DIA);
    if (dias > RANGO_MAXIMO_DIAS) {
      return { error: `El rango no puede superar ${RANGO_MAXIMO_DIAS} días` };
    }
  }

  return { desde, hasta };
}

/** Filtros comunes a las dos agregaciones — una sola validación para ambos endpoints. */
function parsearFiltro(query: Request['query']): FiltroResumen | { error: string } {
  const rango = validarRango(query);
  if ('error' in rango) return rango;

  const coDependencia = typeof query.coDependencia === 'string' ? query.coDependencia.trim() : '';
  if (coDependencia && !CODIGO_DEPENDENCIA_VALIDO.test(coDependencia)) {
    return { error: 'El código de dependencia debe ser numérico de hasta 5 dígitos' };
  }

  const tipoDocumento = typeof query.tipoDocumento === 'string' ? query.tipoDocumento.trim() : '';

  return {
    ...rango,
    coDependencia: coDependencia ? coDependencia.padStart(5, '0') : undefined,
    tipoDocumento: tipoDocumento || undefined,
  };
}

export async function getOficinas(req: Request, res: Response) {
  const filtro = parsearFiltro(req.query);
  if ('error' in filtro) return res.status(400).json({ message: filtro.error });

  try {
    res.json(await desempenoPorOficina(filtro));
  } catch (error) {
    console.error('Error al calcular el desempeño por oficina:', error);
    res.status(500).json({ message: 'Error al calcular el desempeño por oficina' });
  }
}

export async function getEmpleados(req: Request, res: Response) {
  const filtro = parsearFiltro(req.query);
  if ('error' in filtro) return res.status(400).json({ message: filtro.error });

  try {
    res.json(await desempenoPorEmpleado(filtro));
  } catch (error) {
    console.error('Error al calcular el desempeño por empleado:', error);
    res.status(500).json({ message: 'Error al calcular el desempeño por empleado' });
  }
}

export async function getTiposDocumento(_req: Request, res: Response) {
  try {
    res.json(await tiposDocumento());
  } catch (error) {
    console.error('Error al obtener los tipos de documento:', error);
    res.status(500).json({ message: 'Error al obtener los tipos de documento' });
  }
}

/**
 * Sin `desde`/`hasta`: a diferencia de `parsearFiltro`, esto no acota "cuándo se recibió" — mira
 * el backlog completo vigente hoy (ver `pendientesAntiguosPorOficina`). Solo valida lo que sí
 * comparte con el resto del dashboard: oficina y tipo de documento.
 */
function parsearFiltroPendientes(query: Request['query']): FiltroPendientes | { error: string } {
  const coDependencia = typeof query.coDependencia === 'string' ? query.coDependencia.trim() : '';
  if (coDependencia && !CODIGO_DEPENDENCIA_VALIDO.test(coDependencia)) {
    return { error: 'El código de dependencia debe ser numérico de hasta 5 dígitos' };
  }

  const tipoDocumento = typeof query.tipoDocumento === 'string' ? query.tipoDocumento.trim() : '';

  return {
    coDependencia: coDependencia ? coDependencia.padStart(5, '0') : undefined,
    tipoDocumento: tipoDocumento || undefined,
  };
}

export async function getPendientesOficinas(req: Request, res: Response) {
  const filtro = parsearFiltroPendientes(req.query);
  if ('error' in filtro) return res.status(400).json({ message: filtro.error });

  try {
    res.json(await pendientesAntiguosPorOficina(filtro));
  } catch (error) {
    console.error('Error al calcular los pendientes antiguos por oficina:', error);
    res.status(500).json({ message: 'Error al calcular los pendientes antiguos por oficina' });
  }
}

/** Para la nota "Datos actualizados hace X min" — cualquiera con `dashboard.ver` puede leerlo. */
export async function getResumenEstado(_req: Request, res: Response) {
  try {
    res.json(await estadoResumen());
  } catch (error) {
    console.error('Error al obtener el estado del espejo del dashboard:', error);
    res.status(500).json({ message: 'Error al obtener el estado del espejo del dashboard' });
  }
}

/**
 * Refresco manual del espejo — gated por `dashboard.gestionar` (ver rutas), no `dashboard.ver`:
 * es una operación de ~8-10 s contra el SGD, no algo que cualquiera con acceso de solo lectura
 * deba poder disparar a voluntad. Funciona aunque el planificador automático esté apagado, mismo
 * criterio que "Barrer ahora" del panel RAG.
 */
export async function postResumenRefrescar(_req: Request, res: Response) {
  try {
    res.json(await refrescarResumen('manual'));
  } catch (error) {
    if (error instanceof RefrescoOcupado) {
      return res.status(409).json({ message: 'Ya hay un refresco en curso' });
    }
    console.error('Error al refrescar el espejo del dashboard:', error);
    res.status(500).json({ message: 'Error al refrescar el espejo del dashboard' });
  }
}

// ───────────────────────── Fase 3 — pesos por tipo de documento ─────────────────────────

/** Pantalla de administración de pesos — gated por `dashboard.gestionar` (ver rutas): trae
 *  muestra/mediana/sugerencia, no solo el peso vigente, así que no es para cualquiera con
 *  `dashboard.ver`. */
export async function getPesosTipoDocumento(_req: Request, res: Response) {
  try {
    res.json(await listarPesos());
  } catch (error) {
    console.error('Error al listar los pesos por tipo de documento:', error);
    res.status(500).json({ message: 'Error al listar los pesos por tipo de documento' });
  }
}

const PESO_VALIDO = (valor: unknown): valor is number =>
  typeof valor === 'number' && Number.isFinite(valor) && valor > 0 && valor <= 10;

export async function putPesoTipoDocumento(req: Request, res: Response) {
  const { coTipDoc } = req.params;
  const peso = req.body?.peso;

  if (!coTipDoc) return res.status(400).json({ message: 'Falta el código de tipo de documento' });
  if (!PESO_VALIDO(peso)) {
    return res.status(400).json({ message: 'El peso debe ser un número mayor que 0 y hasta 10' });
  }

  try {
    await actualizarPeso(coTipDoc, peso, req.usuario!.codUser);
    res.json({ ok: true });
  } catch (error) {
    console.error(`Error al guardar el peso de ${coTipDoc}:`, error);
    res.status(500).json({ message: 'Error al guardar el peso' });
  }
}
