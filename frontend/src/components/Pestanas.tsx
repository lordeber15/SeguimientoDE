import { useRef } from 'react';

export interface Pestana<T extends string> {
  clave: T;
  etiqueta: string;
}

interface Props<T extends string> {
  pestanas: readonly Pestana<T>[];
  activa: T;
  onCambiar: (clave: T) => void;
  /** Nombre accesible del grupo — lo que anuncia el lector de pantalla antes de las pestañas. */
  etiqueta: string;
}

/** `id` del botón de una pestaña. El panel correspondiente debe apuntarlo con `aria-labelledby`. */
export function idPestana(clave: string): string {
  return `pestana-${clave}`;
}

/** `id` del panel de una pestaña, al que apunta `aria-controls` del botón. */
export function idPanel(clave: string): string {
  return `panel-${clave}`;
}

/**
 * Pestañas reutilizables (`tablist` de WAI-ARIA).
 *
 * Distinto del patrón `.segmentado` que ya usa el conmutador "Horas corridas / Días hábiles":
 * aquél es un grupo de botones de alternancia (`aria-pressed`) porque no cambia de panel, mientras
 * que esto sí navega entre vistas y necesita `role="tab"` + `aria-selected` + tabulación móvil
 * (solo la pestaña activa entra en el orden de tabulación; entre pestañas se mueve con flechas).
 */
export function Pestanas<T extends string>({ pestanas, activa, onCambiar, etiqueta }: Props<T>) {
  const listaRef = useRef<HTMLDivElement>(null);

  function alPulsarTecla(e: React.KeyboardEvent<HTMLDivElement>) {
    const indice = pestanas.findIndex((p) => p.clave === activa);
    if (indice < 0) return;

    let destino: number | null = null;
    if (e.key === 'ArrowRight') destino = (indice + 1) % pestanas.length;
    else if (e.key === 'ArrowLeft') destino = (indice - 1 + pestanas.length) % pestanas.length;
    else if (e.key === 'Home') destino = 0;
    else if (e.key === 'End') destino = pestanas.length - 1;
    if (destino === null) return;

    e.preventDefault();
    const clave = pestanas[destino].clave;
    onCambiar(clave);
    // El foco debe seguir a la pestaña activada, o el siguiente Tab saldría del sitio equivocado.
    listaRef.current?.querySelector<HTMLButtonElement>(`#${idPestana(clave)}`)?.focus();
  }

  return (
    <div
      className="pestanas"
      role="tablist"
      aria-label={etiqueta}
      ref={listaRef}
      onKeyDown={alPulsarTecla}
    >
      {pestanas.map((p) => {
        const seleccionada = p.clave === activa;
        return (
          <button
            key={p.clave}
            type="button"
            role="tab"
            id={idPestana(p.clave)}
            aria-selected={seleccionada}
            aria-controls={idPanel(p.clave)}
            tabIndex={seleccionada ? 0 : -1}
            className={seleccionada ? 'is-activo' : ''}
            onClick={() => onCambiar(p.clave)}
          >
            {p.etiqueta}
          </button>
        );
      })}
    </div>
  );
}
