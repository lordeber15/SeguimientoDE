import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { apiJson } from '../api/cliente';

/**
 * Calidad del chat en producción (docs/PLAN-RAG-AVANZADO.md, Fase 5): el juez LLM sobre una muestra de
 * turnos, las valoraciones 👍/👎 de los usuarios y la última evaluación offline (`npm run eval:rag`).
 * Común al panel del SGD (`/api/rag`) y al del STD (`/api/std/rag`).
 */

interface SemanaCalidad {
  semana: string;
  juicios: number;
  fidelidad: number | null;
  relevancia: number | null;
  usoCitas: number | null;
  abstenciones: number;
  abstencionesIncorrectas: number;
  erroresJuez: number;
  positivas: number;
  negativas: number;
}

interface TurnoObservado {
  mensajeId: number;
  fe: string;
  pregunta: string | null;
  respuesta: string;
  fidelidad: number | null;
  relevancia: number | null;
  comentario: string | null;
  valoracion: 1 | -1 | null;
  comentarioUsuario: string | null;
}

interface ResumenCalidad {
  config: { activo: boolean; muestreo: number; umbralFidelidad: number };
  semanas: SemanaCalidad[];
  peores: TurnoObservado[];
  evalOffline: { id: number; fe: string; casos: number; hitN: number | null; hitK: number | null; mrr: number | null; aceptada: boolean } | null;
}

const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(100 * v)} %`);
const fecha = (iso: string) => new Date(iso).toLocaleDateString('es-PE', { day: '2-digit', month: 'short' });

export function CalidadChatRag({ base }: { base: '/api/rag' | '/api/std/rag' }) {
  const [resumen, setResumen] = useState<ResumenCalidad | null>(null);
  const [muestreo, setMuestreo] = useState('');
  const [umbral, setUmbral] = useState('');
  const [guardando, setGuardando] = useState<string | null>(null);

  const cargar = useCallback(() => {
    apiJson<ResumenCalidad>(`${base}/calidad-chat`, 'leer la calidad del chat')
      .then((r) => {
        setResumen(r);
        setMuestreo(String(r.config.muestreo));
        setUmbral(String(r.config.umbralFidelidad));
      })
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'No se pudo leer la calidad del chat'));
  }, [base]);

  useEffect(cargar, [cargar]);

  async function guardar(clave: string, valor: string, exito: string) {
    setGuardando(clave);
    try {
      await apiJson(`${base}/config/${clave}`, `guardar ${clave}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ valor }),
      });
      toast.success(exito);
      cargar();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `No se pudo guardar ${clave}`);
    } finally {
      setGuardando(null);
    }
  }

  if (!resumen) return <p className="exp-nota">Cargando la calidad del chat…</p>;

  const { config, semanas, peores, evalOffline } = resumen;
  const conDatos = semanas.some((s) => s.juicios > 0 || s.positivas > 0 || s.negativas > 0);

  return (
    <div className="calidad-chat">
      <div className="rag-acciones">
        <div>
          <label className="checkbox-linea">
            <input
              type="checkbox"
              checked={config.activo}
              disabled={guardando === 'chat.juez.activo'}
              onChange={(e) => guardar('chat.juez.activo', String(e.target.checked), `Juez LLM ${e.target.checked ? 'activado' : 'desactivado'}.`)}
            />
            <span>
              Juez LLM
              <span className="exp-nota">
                Evalúa en segundo plano una muestra de las respuestas: fidelidad a los fragmentos, relevancia,
                uso de citas y abstención. No demora al usuario; cada turno juzgado cuesta una llamada al modelo.
              </span>
            </span>
          </label>
        </div>
        <div className="calidad-chat-campos">
          <label>
            Muestreo (0–1)
            <input type="number" min={0} max={1} step={0.05} value={muestreo} onChange={(e) => setMuestreo(e.target.value)} />
          </label>
          <button
            className="boton-secundario"
            disabled={guardando !== null || muestreo === String(config.muestreo)}
            onClick={() => guardar('chat.juez.muestreo', muestreo, 'Muestreo guardado.')}
          >
            Guardar
          </button>
          <label>
            Alerta si la fidelidad baja de
            <input type="number" min={0} max={1} step={0.05} value={umbral} onChange={(e) => setUmbral(e.target.value)} />
          </label>
          <button
            className="boton-secundario"
            disabled={guardando !== null || umbral === String(config.umbralFidelidad)}
            onClick={() => guardar('chat.juez.umbral_fidelidad', umbral, 'Umbral guardado.')}
          >
            Guardar
          </button>
        </div>
      </div>

      <h3 className="calidad-chat-subtitulo">Últimas 8 semanas</h3>
      {conDatos ? (
        <div className="calidad-chat-tabla-envoltura">
          <table className="calidad-chat-tabla">
            <thead>
              <tr>
                <th scope="col">Semana</th>
                <th scope="col">Juicios</th>
                <th scope="col">Fidelidad</th>
                <th scope="col">Relevancia</th>
                <th scope="col">Citas</th>
                <th scope="col" title="Respuestas que dijeron 'no está en la base' / de ellas, sin razón">Abstenciones</th>
                <th scope="col">👍</th>
                <th scope="col">👎</th>
              </tr>
            </thead>
            <tbody>
              {semanas.map((s) => (
                <tr key={s.semana}>
                  <td>{fecha(s.semana)}</td>
                  <td>{s.juicios}{s.erroresJuez > 0 && <span className="exp-nota is-error"> ({s.erroresJuez} con error)</span>}</td>
                  <td className={s.fidelidad !== null && s.fidelidad < config.umbralFidelidad ? 'is-error' : undefined}>{pct(s.fidelidad)}</td>
                  <td>{pct(s.relevancia)}</td>
                  <td>{pct(s.usoCitas)}</td>
                  <td>{s.abstenciones}{s.abstencionesIncorrectas > 0 && ` / ${s.abstencionesIncorrectas} indebidas`}</td>
                  <td>{s.positivas}</td>
                  <td>{s.negativas}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="exp-nota">
          Todavía no hay juicios ni valoraciones. {config.activo ? '' : 'Active el juez LLM para empezar a medir.'}
        </p>
      )}

      <p className="exp-nota">
        {evalOffline
          ? `Evaluación offline #${evalOffline.id} (${fecha(evalOffline.fe)}, ${evalOffline.casos} casos${evalOffline.aceptada ? ', línea base' : ''}): `
            + `Hit@N ${pct(evalOffline.hitN)} · Hit@K ${pct(evalOffline.hitK)} · MRR ${pct(evalOffline.mrr)}.`
          : 'Sin evaluaciones offline todavía (npm run eval:rag).'}
      </p>

      {peores.length > 0 && (
        <>
          <h3 className="calidad-chat-subtitulo">Para revisar (30 días)</h3>
          <p className="exp-nota">
            Respuestas con 👎 o con fidelidad bajo el umbral. Llévelas al dataset con{' '}
            <code>npm run eval:rag:semilla -- --modulo {base === '/api/rag' ? 'sgd' : 'std'} --sinteticos 0 --valorados</code>.
          </p>
          <ul className="calidad-chat-peores">
            {peores.map((p) => (
              <li key={p.mensajeId}>
                <p className="calidad-chat-pregunta">
                  {p.valoracion === -1 && <span aria-label="valoración negativa">👎 </span>}
                  {p.pregunta ?? '(sin pregunta)'}
                </p>
                <p className="exp-nota">
                  {fecha(p.fe)} · mensaje {p.mensajeId}
                  {p.fidelidad !== null && ` · fidelidad ${pct(p.fidelidad)} · relevancia ${pct(p.relevancia)}`}
                  {p.comentario && ` · juez: ${p.comentario}`}
                  {p.comentarioUsuario && ` · usuario: "${p.comentarioUsuario}"`}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
