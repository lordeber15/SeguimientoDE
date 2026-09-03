import type { Request, Response } from 'express';
import {
  flujoProceso,
  listarProcesos,
  propuestaMejora,
  renombrarProceso,
  type FiltroProcesos,
} from '../services/calidadProcesosService';

const FECHA_VALIDA = /^\d{4}-\d{2}-\d{2}$/;
const CODIGO_DEPENDENCIA_VALIDO = /^\d{1,5}$/;
/** La clave de un proceso es el hash que produce `claveDeProceso` (sha1 recortado a 16). */
const CLAVE_PROCESO_VALIDA = /^[0-9a-f]{16}$/;
/** Mismo criterio que `dashboardController`: protege de un rango mal tipeado, no de una consulta
 *  global intencional (que corre igual de rápido contra el espejo local). */
const RANGO_MAXIMO_DIAS = 366;
const MS_POR_DIA = 24 * 60 * 60 * 1000;
const LARGO_MAXIMO_NOMBRE = 120;

/**
 * Mismas reglas de validación que `dashboardController.parsearFiltro` (formato de fecha, rango
 * máximo solo con ambos extremos, código de dependencia numérico con padding a 5) — duplicadas a
 * propósito en vez de importadas: son dos vistas con filtros parecidos pero no idénticos (aquí no
 * hay `tipoDocumento` y sí `soloCerrados`), y acoplarlas obligaría a que cualquier cambio en una
 * tuviera que contemplar la otra.
 *
 * `soloCerrados` es `true` salvo que llegue explícitamente `'false'`: el default de la vista es
 * mostrar solo expedientes archivados, porque uno a medio camino tiene la ruta truncada.
 */
function parsearFiltro(query: Request['query']): FiltroProcesos | { error: string } {
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

  const coDependencia = typeof query.coDependencia === 'string' ? query.coDependencia.trim() : '';
  if (coDependencia && !CODIGO_DEPENDENCIA_VALIDO.test(coDependencia)) {
    return { error: 'El código de dependencia debe ser numérico de hasta 5 dígitos' };
  }

  return {
    desde,
    hasta,
    coDependencia: coDependencia ? coDependencia.padStart(5, '0') : undefined,
    soloCerrados: query.soloCerrados !== 'false',
  };
}

function validarClave(clave: string | undefined): string | null {
  if (!clave || !CLAVE_PROCESO_VALIDA.test(clave)) return null;
  return clave;
}

export async function getProcesos(req: Request, res: Response) {
  const filtro = parsearFiltro(req.query);
  if ('error' in filtro) return res.status(400).json({ message: filtro.error });

  try {
    res.json(await listarProcesos(filtro));
  } catch (error) {
    console.error('Error al listar los procesos detectados:', error);
    res.status(500).json({ message: 'Error al listar los procesos detectados' });
  }
}

export async function getFlujo(req: Request, res: Response) {
  const clave = validarClave(req.params.clave);
  if (!clave) return res.status(400).json({ message: 'Clave de proceso inválida' });

  const filtro = parsearFiltro(req.query);
  if ('error' in filtro) return res.status(400).json({ message: filtro.error });

  try {
    const flujo = await flujoProceso(clave, filtro);
    if (!flujo) {
      return res.status(404).json({ message: 'No hay expedientes de ese proceso con estos filtros' });
    }
    res.json(flujo);
  } catch (error) {
    console.error(`Error al calcular el flujo del proceso ${clave}:`, error);
    res.status(500).json({ message: 'Error al calcular el flujo del proceso' });
  }
}

export async function getPropuesta(req: Request, res: Response) {
  const clave = validarClave(req.params.clave);
  if (!clave) return res.status(400).json({ message: 'Clave de proceso inválida' });

  const filtro = parsearFiltro(req.query);
  if ('error' in filtro) return res.status(400).json({ message: filtro.error });

  try {
    const propuesta = await propuestaMejora(clave, filtro);
    if (!propuesta) {
      return res.status(404).json({ message: 'No hay expedientes de ese proceso con estos filtros' });
    }
    res.json(propuesta);
  } catch (error) {
    console.error(`Error al calcular la propuesta del proceso ${clave}:`, error);
    res.status(500).json({ message: 'Error al calcular la propuesta de mejora' });
  }
}

export async function putNombreProceso(req: Request, res: Response) {
  const clave = validarClave(req.params.clave);
  if (!clave) return res.status(400).json({ message: 'Clave de proceso inválida' });

  const nombre = typeof req.body?.nombre === 'string' ? req.body.nombre.trim() : '';
  if (!nombre) return res.status(400).json({ message: 'El nombre no puede estar vacío' });
  if (nombre.length > LARGO_MAXIMO_NOMBRE) {
    return res.status(400).json({ message: `El nombre no puede superar ${LARGO_MAXIMO_NOMBRE} caracteres` });
  }

  try {
    await renombrarProceso(clave, nombre, req.usuario!.codUser);
    res.json({ ok: true });
  } catch (error) {
    console.error(`Error al renombrar el proceso ${clave}:`, error);
    res.status(500).json({ message: 'Error al renombrar el proceso' });
  }
}
