/**
 * Primer SVG inline de todo el frontend (hasta ahora los indicadores de expandir/colapsar usan
 * caracteres Unicode, ▸/▾). Convenciones para el próximo icono que se agregue:
 *
 * - `viewBox` fijo + `width`/`height` por prop, nunca por CSS: así no se aplasta dentro de un
 *   contenedor flex.
 * - `stroke="currentColor"`: hereda el color del botón que lo envuelve, incluido su estado
 *   `:disabled`, sin CSS aparte.
 * - `aria-hidden="true"` + `focusable="false"` en el `<svg>`, SIN `role="img"` ni `aria-label`
 *   aquí — el nombre accesible va en el `<button>` que lo envuelve. Ponerlo en los dos hace que
 *   un lector de pantalla anuncie el nombre dos veces.
 */
export function IconoChat({ size = 18 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}
