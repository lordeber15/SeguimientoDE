import { ThinkingOrb, type OrbState } from 'thinking-orbs';

interface Props {
  estado: OrbState;
  /** 20 = en línea con el texto, 64 = tamaño avatar. La librería afina cada uno por separado. */
  tamano?: 20 | 64;
}

/**
 * Indicador de "el asistente está pensando". Envuelve `thinking-orbs` para que las páginas no
 * dependan de la librería directamente. Es decorativo (`aria-hidden`): lo que se anuncia es el
 * texto que lo acompaña. `prefers-reduced-motion` ya lo respeta la propia librería.
 *
 * `theme="light"` fijo: la app todavía no tiene modo oscuro, y con el `auto` por defecto el orbe
 * seguiría al sistema operativo y pintaría tinta clara sobre el fondo blanco (invisible). El día que
 * haya modo oscuro, se resuelve solo aquí.
 */
export function OrbePensando({ estado, tamano = 20 }: Props) {
  return (
    <span className="chat-escribiendo-orbe" aria-hidden="true">
      <ThinkingOrb state={estado} size={tamano} theme="light" />
    </span>
  );
}
