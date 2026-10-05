import { useEffect, useState } from 'react';
import type { FilaResultadoChat, TablaResultadosChat as Tabla } from '../api/chatComun';

interface Props {
  tabla: Tabla;
  mensajeId: string;
  cargarPagina: (mensajeId: number, pagina: number) => Promise<Tabla>;
  etiquetaFila: (fila: FilaResultadoChat) => string;
  /** "Chatear": abre el chat por contexto con esa fila. Sin él, la columna no se muestra. */
  onChatear?: (fila: FilaResultadoChat) => void;
  /** Encabezado de la primera columna ("Expediente" en el SGD, "Documento" en el STD). */
  encabezadoNumero?: string;
}

/** "2026-10-02" → "02/10/2026" (formato del resto de la app). */
function fecha(iso: string | null): string {
  if (!iso) return '—';
  const [a, m, d] = iso.split('-');
  return d && m && a ? `${d}/${m}/${a}` : iso;
}

/**
 * Respuesta tabla del chat (listar / contar, docs/PLAN-CHAT-CONSULTAS.md D4/D6): 10 filas y
 * "Ver más". Las filas de nivel 2 (el término solo aparece dentro de los documentos) van detrás de
 * un separador: son las que más ruido traen y no deben leerse como coincidencias directas.
 *
 * Viniendo del historial, la tabla llega sin filas (`pagina: 0`) y la primera página se pide al
 * montarse — abrir una conversación no re-consulta el SGD por cada listado antiguo.
 */
export function TablaResultadosChat({
  tabla, mensajeId, cargarPagina, etiquetaFila, onChatear, encabezadoNumero = 'Expediente',
}: Props) {
  const [filas, setFilas] = useState<FilaResultadoChat[]>(tabla.filas);
  const [pagina, setPagina] = useState(tabla.pagina);
  const [hayMas, setHayMas] = useState(tabla.hayMas);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cargarSiguiente() {
    if (cargando) return;
    setCargando(true);
    setError(null);
    try {
      const siguiente = await cargarPagina(Number(mensajeId), pagina + 1);
      setFilas((previas) => [...previas, ...siguiente.filas]);
      setPagina(siguiente.pagina);
      setHayMas(siguiente.hayMas);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudieron cargar más resultados');
    } finally {
      setCargando(false);
    }
  }

  useEffect(() => {
    if (tabla.pagina === 0 && tabla.total > 0) void cargarSiguiente();
    // Solo al montar: `cargarSiguiente` cambia en cada render y re-dispararía la carga.
  }, []);

  if (tabla.total === 0) return null;

  return (
    <div className="chat-tabla">
      <div className="table-scroll">
        <table className="chat-tabla-resultados">
          <thead>
            <tr>
              <th className="col-numero">{encabezadoNumero}</th>
              <th>Asunto</th>
              <th className="col-origen">Origen</th>
              <th className="col-movimiento">Último movimiento</th>
              <th className="col-estado">Estado</th>
              <th className="col-coincidencia">Coincidencia</th>
              {onChatear && <th className="col-accion"><span className="sr-only">Acciones</span></th>}
            </tr>
          </thead>
          <tbody>
            {filas.map((f, i) => {
              const abreNivel2 = f.nivel === 2 && (i === 0 || filas[i - 1].nivel === 1);
              const etiqueta = etiquetaFila(f);
              return [
                abreNivel2 ? (
                  <tr key={`sep-${etiqueta}`} className="chat-tabla-separador">
                    <td colSpan={onChatear ? 7 : 6}>
                      Mencionados solo dentro del contenido de sus archivos ({tabla.nivel2})
                    </td>
                  </tr>
                ) : null,
                <tr key={etiqueta} className={f.nivel === 2 ? 'is-nivel2' : undefined}>
                  <td className="col-numero">{etiqueta}</td>
                  <td title={f.asunto ?? undefined}>
                    <span className="chat-tabla-asunto">{f.asunto ?? '—'}</span>
                  </td>
                  <td className="col-origen">
                    {f.origen ?? '—'}
                    {f.remitentes.length > 0 && f.remitentes[0] !== f.origen && (
                      <span className="chat-tabla-sub">Remitente: {f.remitentes.join(', ')}</span>
                    )}
                  </td>
                  <td className="col-movimiento">
                    {fecha(f.ultimoMovimiento)}
                    {f.dependenciaActual && <span className="chat-tabla-sub">{f.dependenciaActual}</span>}
                  </td>
                  <td className="col-estado">
                    {f.archivado ? (
                      <span className="badge badge-atendido" title={f.feArchivo ? `Archivado el ${fecha(f.feArchivo)}` : undefined}>
                        Archivado{f.feArchivo ? ` ${fecha(f.feArchivo)}` : ''}
                      </span>
                    ) : (
                      <span className="badge badge-progreso">En trámite</span>
                    )}
                  </td>
                  <td className="col-coincidencia">{f.coincidencia}</td>
                  {onChatear && (
                    <td className="col-accion">
                      <button type="button" className="boton-enlace" onClick={() => onChatear(f)}>
                        Chatear
                      </button>
                    </td>
                  )}
                </tr>,
              ];
            })}
            {cargando && filas.length === 0 && (
              <tr>
                <td colSpan={onChatear ? 7 : 6} className="chat-tabla-cargando">Cargando resultados…</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="chat-tabla-pie">
        <span>
          Mostrando {filas.length} de {tabla.total}
        </span>
        {hayMas && (
          <button type="button" className="boton-secundario" onClick={() => void cargarSiguiente()} disabled={cargando}>
            {cargando ? 'Cargando…' : 'Ver más'}
          </button>
        )}
      </div>
      {error && <p className="exp-nota is-error">{error}</p>}
    </div>
  );
}
