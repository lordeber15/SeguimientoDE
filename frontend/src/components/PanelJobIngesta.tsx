import { useEffect, useRef, useState } from 'react';
import type { FaseConversion, JobIngesta, ProcesoActualJob } from '../api/rag';

interface Props {
  job: JobIngesta;
  /** 'compacta' = una celda de tabla: sin cronómetro, sin nota, título truncado y barras finas —
   *  ver `CeldaIndexacion.tsx`, cuya propia frase de 260 px ya descuadró el ancho de esa tabla
   *  una vez. 'completa' es el panel de siempre, usado en `RagPanelPage`. */
  variante?: 'completa' | 'compacta';
  /** Los controles se dibujan SOLO si llegan sus handlers: así el modal, que no ofrece control
   *  del trabajo, no necesita ninguna bandera extra — simplemente no los pasa. */
  onPausar?: () => void;
  onReanudar?: () => void;
  onDetener?: () => void;
  /** Sin él no se dibuja la nota "Este trabajo tomó los N documento(s)…" ni su botón. */
  onVerDocumentos?: () => void;
}

/**
 * Espejo de `TRAMOS_FASE` en `backend/src/rag/fasesConversion.ts`. Se duplica a mano, con el mismo
 * criterio con el que este panel ya duplicaba la lógica de `conversionBloqueada()` en
 * `RagPanelPage`: son nueve pares de números estables, y mandarlos en cada respuesta del sondeo
 * (cada 1500 ms) para poder dibujar los marcadores de las fases que todavía no han ocurrido sería
 * pagar ancho de banda por una tabla que no cambia nunca. Si cambian allí, cambian aquí.
 */
const TRAMOS: Record<FaseConversion, readonly [number, number]> = {
  descargando: [0, 10],
  deduplicando: [10, 15],
  esperando_circuito: [15, 15],
  en_cola_conversor: [15, 15],
  convirtiendo: [15, 85],
  generando: [15, 85],
  troceando: [85, 93],
  guardando: [93, 100],
  listo: [100, 100],
};

const ETIQUETA_FASE: Record<FaseConversion, string> = {
  descargando: 'Obteniendo el archivo',
  generando: 'Generando el texto desde los datos del SGD',
  deduplicando: 'Comprobando si ya estaba convertido',
  esperando_circuito: 'Esperando a que el conversor vuelva',
  en_cola_conversor: 'En cola del conversor',
  convirtiendo: 'Convirtiendo',
  troceando: 'Limpiando y troceando',
  guardando: 'Guardando los fragmentos',
  listo: 'Listo',
};

/** Fases en las que la barra NO avanza porque no está avanzando nada: no es que no sepamos cuánto
 *  queda, es que el trabajo está detenido esperando a otro. Se dibujan con rayas en movimiento. */
const FASES_DE_ESPERA: FaseConversion[] = ['esperando_circuito', 'en_cola_conversor'];

const INTERVALO_RELOJ_MS = 500;

/**
 * Milisegundos transcurridos desde que llegó ESTA respuesta del sondeo.
 *
 * Se ancla en el instante de RECEPCIÓN en el navegador, no en ninguna fecha del servidor: es lo
 * que hace que el desfase entre los dos relojes no juegue ningún papel (el único error que queda
 * es la latencia de la respuesta, decenas de ms). `job` es un objeto nuevo en cada `fetchJob`, así
 * que la propia identidad del objeto sirve de disparo del reanclaje.
 */
function useDesdeUltimoDato(job: JobIngesta, activo: boolean): number {
  const recibidoEn = useRef(Date.now());
  const [ahora, setAhora] = useState(() => Date.now());

  useEffect(() => {
    recibidoEn.current = Date.now();
    setAhora(Date.now());
  }, [job]);

  useEffect(() => {
    if (!activo) return;
    const id = setInterval(() => setAhora(Date.now()), INTERVALO_RELOJ_MS);
    return () => clearInterval(id);
  }, [activo]);

  return Math.max(0, ahora - recibidoEn.current);
}

/**
 * Porcentaje de la barra del documento. Dos garantías:
 *  - nunca rebasa el final de su tramo (`Math.min`): un documento colgado 45 minutos —ya pasó—
 *    se queda pegado al final de "convirtiendo", no invade "troceando" ni llega al 100 %;
 *  - nunca retrocede, y por construcción, no por un máximo defensivo: los tramos son crecientes,
 *    dentro de un tramo `faseMs` solo crece, y el intento 2 del fallback empieza justo donde
 *    terminaba el 1. El único reinicio a 0 posible es el cambio de documento, que es correcto.
 */
function pctDocumento(proceso: ProcesoActualJob, msLocales: number): number | null {
  const tramo = proceso.fase && TRAMOS[proceso.fase];
  if (!tramo) return null; // fase ausente o desconocida ⇒ barra indeterminada

  let [inicio, fin] = tramo;

  // El tramo de conversión se reparte a partes iguales entre los intentos posibles: con respaldo
  // configurado, el activo se queda la primera mitad y el respaldo la segunda, de modo que el
  // salto al respaldo se VE como un salto y no como "sigue igual de lento".
  const intentos = proceso.intentos ?? 1;
  if (proceso.fase === 'convirtiendo' && intentos > 1) {
    const ancho = (fin - inicio) / intentos;
    inicio += ancho * ((proceso.intento ?? 1) - 1);
    fin = inicio + ancho;
  }

  const esperando = FASES_DE_ESPERA.includes(proceso.fase!);
  const limite = proceso.faseLimiteMs ?? 0;
  // Solo se interpola donde hay un tope conocido: es la única forma honesta de saber cuánto
  // queda. Las fases sin tope duran décimas de segundo y se dibujan como escalones — se quedan en
  // su `inicio` y saltan al entrar en la siguiente.
  if (limite <= 0 || esperando) return inicio;

  const avance = Math.min(((proceso.faseMs ?? 0) + msLocales) / limite, 1);
  return Math.min(inicio + (fin - inicio) * avance, fin);
}

/** Posiciones (%) donde se dibuja un separador entre fases del tramo determinado del documento.
 *  Incluye el punto medio de "convirtiendo" cuando hay respaldo configurado: es justo donde el
 *  intento 1 le cede el turno al intento 2. */
function marcasDeTramo(proceso: ProcesoActualJob): number[] {
  const puntos = [TRAMOS.descargando[1], TRAMOS.deduplicando[1], TRAMOS.convirtiendo[1], TRAMOS.troceando[1]];
  const intentos = proceso.intentos ?? 1;
  if (intentos > 1) {
    const [inicio, fin] = TRAMOS.convirtiendo;
    puntos.push(inicio + (fin - inicio) / intentos);
  }
  return puntos;
}

/** Tramo [izquierda, ancho] en % que representa el intento que YA FALLÓ antes del actual — el
 *  minuto que se gastó en markitdown antes de caer a mineru. Solo existe a partir del intento 2:
 *  ese tiempo pasó de verdad, pero no fue trabajo aprovechado, y el color lo dice. */
function tramoFallido(proceso: ProcesoActualJob): { izquierda: number; ancho: number } | null {
  const intentos = proceso.intentos ?? 1;
  const intento = proceso.intento ?? 1;
  if (intentos <= 1 || intento <= 1) return null;
  const [inicio, fin] = TRAMOS.convirtiendo;
  const ancho = (fin - inicio) / intentos;
  return { izquierda: inicio, ancho: ancho * (intento - 1) };
}

/** Línea de detalle bajo el nombre de la fase — todo derivado de campos que ya llegan, sin pedir nada nuevo. */
function detalleFase(proceso: ProcesoActualJob, msLocales: number): string | null {
  const limite = proceso.faseLimiteMs ?? null;

  if (proceso.fase === 'convirtiendo') {
    const partes = [
      proceso.intentos && proceso.intentos > 1 ? `intento ${proceso.intento} de ${proceso.intentos}` : null,
      proceso.intentos && proceso.intentos > 1 && proceso.intento === 2 ? 'respaldo' : null,
      limite ? `${Math.round(((proceso.faseMs ?? 0) + msLocales) / 1000)} s de máx. ${Math.round(limite / 1000)} s` : null,
    ].filter(Boolean);
    return partes.length > 0 ? partes.join(' · ') : null;
  }
  if (proceso.fase === 'esperando_circuito') {
    if (!limite) return 'en reposo tras varios fallos seguidos';
    const restante = Math.max(0, Math.round((limite - (proceso.faseMs ?? 0) - msLocales) / 1000));
    return `en reposo tras varios fallos seguidos; vuelve en ${restante} s`;
  }
  if (proceso.fase === 'en_cola_conversor') {
    return 'otro documento está usando el conversor';
  }
  return null;
}

export function PanelJobIngesta({
  job,
  variante = 'completa',
  onPausar,
  onReanudar,
  onDetener,
  onVerDocumentos,
}: Props) {
  const proceso = job.procesoActual;
  const activo = job.estado === 'en_curso' && !!proceso?.fase;
  const msLocales = useDesdeUltimoDato(job, activo);

  const pct = proceso ? pctDocumento(proceso, msLocales) : null;
  const esperando = proceso?.fase && FASES_DE_ESPERA.includes(proceso.fase);
  const compacta = variante === 'compacta';
  const fallido = proceso ? tramoFallido(proceso) : null;
  const marcas = !compacta && proceso ? marcasDeTramo(proceso) : [];

  return (
    <div className={`rag-job${compacta ? ' panel-job--compacta' : ''}`} role="status" aria-live="polite">
      <p>
        Trabajo #{job.id} ({job.tipo}) — {job.estado}
        {job.total > 0 && ` · ${job.procesados}/${job.total}`}
        {job.errores > 0 && ` · ${job.errores} error(es)`}
      </p>

      {(onPausar || onReanudar || onDetener)
        && (job.tipo === 'conversion' || job.tipo === 'reparacion')
        && (job.estado === 'en_curso' || job.estado === 'pausado') && (
        <div className="rag-job-controles">
          {job.estado === 'en_curso' && onPausar && (
            <button type="button" className="boton-secundario" onClick={onPausar}>Pausar</button>
          )}
          {job.estado === 'pausado' && onReanudar && (
            <button type="button" className="boton-secundario" onClick={onReanudar}>Reanudar</button>
          )}
          {onDetener && (
            <button type="button" className="boton-secundario" onClick={onDetener}>Detener</button>
          )}
        </div>
      )}

      {job.total > 0 && (
        <div className="barra-progreso">
          <div
            className="barra-progreso-relleno"
            style={{ width: `${Math.round((job.procesados / job.total) * 100)}%` }}
          />
        </div>
      )}

      {proceso && (
        <div className="rag-job-actual">
          {!compacta && (
            <p className="exp-nota">
              Procesando: <strong>{proceso.titulo ?? `Documento #${proceso.documentoId}`}</strong>
              {' '}— {proceso.segundos} s
            </p>
          )}
          {compacta && (
            <p className="rag-job-fase-nombre" title={proceso.titulo ?? `Documento #${proceso.documentoId}`}>
              {proceso.titulo ?? `Documento #${proceso.documentoId}`}
            </p>
          )}

          {pct === null ? (
            <div className="barra-progreso-indeterminada" />
          ) : (
            <div className="barra-progreso barra-progreso--documento">
              {fallido && (
                <div
                  className="barra-progreso-fallido"
                  style={{ left: `${fallido.izquierda}%`, width: `${fallido.ancho}%` }}
                />
              )}
              <div className="barra-progreso-relleno" style={{ width: `${pct}%` }} />
              {esperando && <div className="barra-progreso-espera" style={{ width: `${100 - pct}%` }} />}
              {marcas.length > 0 && (
                <div className="barra-progreso-marcas">
                  {marcas.map((p) => (
                    <div key={p} className="barra-progreso-marca" style={{ left: `${p}%` }} />
                  ))}
                </div>
              )}
            </div>
          )}

          {!compacta && proceso.fase && (
            <p className="rag-job-fase">
              <span className="rag-job-fase-nombre">
                {ETIQUETA_FASE[proceso.fase]}
                {proceso.proveedor && ` con ${proceso.proveedor}`}
              </span>
              {detalleFase(proceso, msLocales) && (
                <span className="rag-job-fase-detalle">{detalleFase(proceso, msLocales)}</span>
              )}
            </p>
          )}
          {!compacta && proceso.motivoFallback && (
            <p className="rag-job-fase-fallback">{proceso.motivoFallback}</p>
          )}
        </div>
      )}

      {/* Pausar o detener no aborta el documento que ya está en vuelo (no hay forma de cortar a
          mitad una llamada HTTP al conversor). Sin decirlo, la barra siguiendo viva tras pulsar
          "Detener" parece que el botón no funcionó. */}
      {!compacta && job.estado !== 'en_curso' && proceso && (
        <p className="exp-nota">El trabajo ya no toma documentos nuevos; el que estaba en marcha termina solo.</p>
      )}

      {!compacta && job.total > 0 && onVerDocumentos && (
        <p className="exp-nota">
          Este trabajo tomó los {job.total} documento(s) que cumplían el filtro al
          momento de iniciarlo — no todo el corpus. De esos, {job.procesados} ya se
          intentaron (con éxito o con error); quedan{' '}
          {Math.max(job.total - job.procesados, 0)} en cola.{' '}
          <button type="button" className="boton-enlace" onClick={onVerDocumentos}>
            Ver qué documentos son
          </button>
        </p>
      )}

      {!compacta && job.mensaje && <p className="exp-nota is-error">{job.mensaje}</p>}
    </div>
  );
}
