import type { Request, Response } from 'express';
import {
  buscarExpedientePorNumero,
  getExpedientesPorUsuario,
  getUsuariosPorDependencia,
} from '../services/seguimientoService';

// Los códigos del SGD son cadenas cortas de dígitos con ceros a la izquierda ('00009', '00104').
// Validar el formato antes de tocar la BD evita consultas inútiles y deja claro en el 400 qué
// se esperaba. (La inyección ya está cubierta: los valores viajan como parámetros `bind`.)
const CODIGO_VALIDO = /^\d{1,5}$/;

function normalizarCodigo(valor: unknown): string | null {
  if (typeof valor !== 'string') return null;
  const limpio = valor.trim();
  if (!CODIGO_VALIDO.test(limpio)) return null;
  return limpio.padStart(5, '0');
}

export async function getUsuarios(req: Request, res: Response) {
  const coDependencia = normalizarCodigo(req.params.coDependencia);

  if (!coDependencia) {
    return res.status(400).json({ message: 'El código de dependencia debe ser numérico de hasta 5 dígitos' });
  }

  try {
    res.json(await getUsuariosPorDependencia(coDependencia));
  } catch (error) {
    console.error('Error al obtener usuarios de la dependencia:', error);
    res.status(500).json({ message: 'Error al obtener los usuarios de la dependencia' });
  }
}

const LARGO_MIN_BUSQUEDA = 3;

export async function getBuscarExpediente(req: Request, res: Response) {
  const termino = typeof req.query.q === 'string' ? req.query.q.trim() : '';

  if (termino.length < LARGO_MIN_BUSQUEDA) {
    return res.status(400).json({ message: `Escriba al menos ${LARGO_MIN_BUSQUEDA} caracteres del número de expediente` });
  }

  try {
    res.json(await buscarExpedientePorNumero(termino));
  } catch (error) {
    console.error('Error al buscar expediente:', error);
    res.status(500).json({ message: 'Error al buscar el expediente' });
  }
}

export async function getExpedientes(req: Request, res: Response) {
  const coDependencia = normalizarCodigo(req.query.dependencia);
  const coEmpleado = normalizarCodigo(req.query.usuario);

  if (!coDependencia || !coEmpleado) {
    return res.status(400).json({ message: 'Se requieren los parámetros "dependencia" y "usuario" (códigos numéricos)' });
  }

  try {
    const items = await getExpedientesPorUsuario(coDependencia, coEmpleado);
    res.json({ total: items.length, items });
  } catch (error) {
    console.error('Error al obtener expedientes del usuario:', error);
    res.status(500).json({ message: 'Error al obtener los expedientes del usuario' });
  }
}
