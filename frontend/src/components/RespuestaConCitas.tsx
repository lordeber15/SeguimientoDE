import { Fragment } from 'react';
import { idCita } from './CitaBadge';

/**
 * El texto del asistente con sus marcadores `[Dn]` convertidos en badges pulsables.
 *
 * El backend ya deja en el texto solo los marcadores que resuelven a una cita real
 * (`limpiarMarcadores` borra los que el modelo inventa), así que aquí cada `[Dn]` que aparece tiene
 * garantizada su cita. Aun así se comprueba contra `numerosValidos`: si alguna vez llegara uno
 * suelto, se pinta como texto normal en vez de dar un badge que no lleva a ningún sitio.
 */

// Grupo capturado: `split` conserva los delimitadores y los índices impares son el número.
const RE_MARCADOR = /\[D(\d+)\]/g;

interface Props {
  texto: string;
  numerosValidos: Set<number>;
  mensajeId: string;
  onIrACita: (numero: number) => void;
}

export function RespuestaConCitas({ texto, numerosValidos, mensajeId, onIrACita }: Props) {
  const partes = texto.split(RE_MARCADOR);

  return (
    <p className="chat-texto">
      {partes.map((parte, i) => {
        if (i % 2 === 0) return <Fragment key={i}>{parte}</Fragment>;

        const numero = Number(parte);
        if (!numerosValidos.has(numero)) return <Fragment key={i}>{`[D${parte}]`}</Fragment>;

        return (
          <button
            key={i}
            type="button"
            className="chat-marcador"
            aria-label={`Ver la fuente D${numero}`}
            aria-controls={idCita(mensajeId, numero)}
            onClick={() => onIrACita(numero)}
          >
            D{numero}
          </button>
        );
      })}
    </p>
  );
}
