import { useCallback, useEffect, useRef, useState } from 'react';

export type TipoToast = 'cargando' | 'ok' | 'error';

export interface Toast {
  id: number;
  tipo: TipoToast;
  texto: string;
}

const DURACION_MS: Record<Exclude<TipoToast, 'cargando'>, number> = {
  ok: 5000,
  error: 8000,
};

let siguienteId = 1;

/**
 * Pila de toasts con reemplazo en el sitio: `mostrar` abre uno y devuelve su id, `actualizar` lo
 * muta (usado para pasar de "cargando" a "ok"/"error" sin apilar un segundo aviso). Solo "ok" y
 * "error" se autocierran — "cargando" queda hasta que algo lo actualice o lo cierre a mano.
 */
export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    const mapa = timers.current;
    return () => {
      mapa.forEach((t) => clearTimeout(t));
      mapa.clear();
    };
  }, []);

  const programarCierre = useCallback((id: number, tipo: TipoToast) => {
    const previo = timers.current.get(id);
    if (previo) clearTimeout(previo);
    if (tipo === 'cargando') {
      timers.current.delete(id);
      return;
    }
    const t = setTimeout(() => {
      timers.current.delete(id);
      setToasts((actuales) => actuales.filter((x) => x.id !== id));
    }, DURACION_MS[tipo]);
    timers.current.set(id, t);
  }, []);

  const mostrar = useCallback(
    (tipo: TipoToast, texto: string): number => {
      const id = siguienteId++;
      setToasts((actuales) => [...actuales, { id, tipo, texto }]);
      programarCierre(id, tipo);
      return id;
    },
    [programarCierre],
  );

  const actualizar = useCallback(
    (id: number, tipo: TipoToast, texto: string) => {
      setToasts((actuales) => actuales.map((t) => (t.id === id ? { id, tipo, texto } : t)));
      programarCierre(id, tipo);
    },
    [programarCierre],
  );

  const cerrar = useCallback((id: number) => {
    const previo = timers.current.get(id);
    if (previo) clearTimeout(previo);
    timers.current.delete(id);
    setToasts((actuales) => actuales.filter((x) => x.id !== id));
  }, []);

  return { toasts, mostrar, actualizar, cerrar };
}

export function PilaToasts({ toasts, onCerrar }: { toasts: Toast[]; onCerrar: (id: number) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-pila" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast toast--${t.tipo}`}
          role={t.tipo === 'error' ? 'alert' : 'status'}
        >
          {t.tipo === 'cargando' && <span className="toast-spinner" aria-hidden="true" />}
          <span className="toast-texto">{t.texto}</span>
          <button
            type="button"
            className="toast-cerrar"
            aria-label="Cerrar aviso"
            onClick={() => onCerrar(t.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
