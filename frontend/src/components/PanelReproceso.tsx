import { useEffect, useRef, useState } from 'react';
import type { ClienteReproceso, EstadoReproceso, OpcionProveedorVision, ProveedorVision } from '../api/reproceso';

interface Props {
  cliente: ClienteReproceso;
  /** El markdown cambió en la base: el visor debe volver a pedirlo. */
  onTerminado: () => void;
}

/** El reproceso corre en el servidor; con Ollama una página tarda decenas de segundos. */
const INTERVALO_SONDEO_MS = 3_000;

/**
 * Barra del panel de markdown del visor: elegir proveedor y modelo de visión y volver a extraer el
 * texto del documento. Al terminar, el markdown nuevo ya está guardado; si se pidió, se lanzan sus
 * embeddings para que vuelva a entrar en el chat.
 */
export function PanelReproceso({ cliente, onTerminado }: Props) {
  const [opciones, setOpciones] = useState<OpcionProveedorVision[] | null>(null);
  const [errorOpciones, setErrorOpciones] = useState<string | null>(null);
  const [proveedor, setProveedor] = useState<ProveedorVision>('ollama');
  const [modelo, setModelo] = useState('');
  const [embeber, setEmbeber] = useState(true);
  const [estado, setEstado] = useState<EstadoReproceso | null>(null);
  const [aviso, setAviso] = useState<{ tipo: 'ok' | 'error'; texto: string } | null>(null);
  const [enviando, setEnviando] = useState(false);

  // El sondeo decide qué hacer al terminar según lo que se pidió al lanzar, no según lo que diga la
  // casilla si alguien la cambió mientras tanto.
  const embeberAlTerminar = useRef(false);
  const sondeando = estado?.estado === 'en_curso';

  useEffect(() => {
    let vigente = true;
    cliente
      .opciones()
      .then((lista) => {
        if (!vigente) return;
        setOpciones(lista);
        const inicial = lista.find((o) => o.nombre === 'ollama' && o.disponible) ?? lista.find((o) => o.disponible) ?? lista[0];
        if (inicial) {
          setProveedor(inicial.nombre);
          setModelo(inicial.modeloPorDefecto);
        }
      })
      .catch((e: unknown) => vigente && setErrorOpciones(e instanceof Error ? e.message : 'Error desconocido'));
    // Si el visor se reabre con un reproceso a medias, se retoma el sondeo.
    cliente
      .consultar()
      .then((r) => vigente && r?.estado === 'en_curso' && setEstado(r))
      .catch(() => {});
    return () => {
      vigente = false;
    };
  }, [cliente]);

  useEffect(() => {
    if (!sondeando) return;
    const id = setInterval(() => {
      cliente
        .consultar()
        .then(async (r) => {
          if (!r || r.estado === 'en_curso') {
            if (r) setEstado(r);
            return;
          }
          setEstado(r);
          if (r.estado === 'error') {
            setAviso({ tipo: 'error', texto: r.mensaje });
            return;
          }
          let texto = `Markdown actualizado con ${r.proveedor}/${r.modelo} (${r.chars.toLocaleString('es-PE')} caracteres).`;
          if (embeberAlTerminar.current) {
            try {
              const { jobId } = await cliente.embeber();
              texto += ` Embeddings en curso (trabajo #${jobId}).`;
            } catch (e: unknown) {
              texto += ` No se pudieron lanzar los embeddings: ${e instanceof Error ? e.message : 'error desconocido'}.`;
            }
          } else {
            texto += ' Queda fuera del chat hasta generar sus embeddings.';
          }
          setAviso({ tipo: 'ok', texto });
          onTerminado();
        })
        .catch(() => {});
    }, INTERVALO_SONDEO_MS);
    return () => clearInterval(id);
  }, [sondeando, cliente, onTerminado]);

  const opcion = opciones?.find((o) => o.nombre === proveedor);

  async function reprocesar() {
    setAviso(null);
    setEnviando(true);
    embeberAlTerminar.current = embeber;
    try {
      setEstado(await cliente.iniciar(proveedor, modelo.trim()));
    } catch (e: unknown) {
      setAviso({ tipo: 'error', texto: e instanceof Error ? e.message : 'No se pudo iniciar el reproceso' });
    } finally {
      setEnviando(false);
    }
  }

  if (errorOpciones) {
    return <p className="exp-nota is-error">Reproceso no disponible: {errorOpciones}</p>;
  }

  return (
    <div className="panel-reproceso">
      <div className="panel-reproceso-controles">
        <label>
          Proveedor
          <select
            value={proveedor}
            disabled={!opciones || sondeando}
            onChange={(e) => {
              const nuevo = e.target.value as ProveedorVision;
              setProveedor(nuevo);
              setModelo(opciones?.find((o) => o.nombre === nuevo)?.modeloPorDefecto ?? '');
            }}
          >
            {(opciones ?? []).map((o) => (
              <option key={o.nombre} value={o.nombre} disabled={!o.disponible}>
                {o.etiqueta}
                {o.disponible ? '' : ' (no disponible)'}
              </option>
            ))}
          </select>
        </label>
        <label>
          Modelo
          <input
            list={`modelos-${proveedor}`}
            value={modelo}
            disabled={!opciones || sondeando}
            onChange={(e) => setModelo(e.target.value)}
            placeholder={opcion?.modeloPorDefecto}
            spellCheck={false}
          />
          <datalist id={`modelos-${proveedor}`}>
            {(opcion?.modelos ?? []).map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
        <label className="panel-reproceso-casilla">
          <input type="checkbox" checked={embeber} disabled={sondeando} onChange={(e) => setEmbeber(e.target.checked)} />
          Generar embeddings al terminar
        </label>
        <button
          type="button"
          className="boton-secundario"
          onClick={reprocesar}
          disabled={!opcion?.disponible || sondeando || enviando}
          title={opcion && !opcion.disponible ? opcion.motivo ?? undefined : undefined}
          aria-busy={sondeando || enviando}
        >
          {sondeando ? 'Reprocesando…' : 'Reprocesar'}
        </button>
      </div>

      {opcion && !opcion.disponible && opcion.motivo && <p className="exp-nota is-error">{opcion.motivo}</p>}
      {proveedor === 'openai' && opcion?.disponible && !sondeando && (
        <p className="exp-nota">Consume tokens de OpenAI.</p>
      )}
      {estado?.estado === 'en_curso' && (
        <p className="exp-nota" role="status">
          Reprocesando con {estado.proveedor}/{estado.modelo}
          {estado.paginas ? ` — página ${estado.pagina} de ${estado.paginas}` : '…'} El markdown actual se reemplaza
          al terminar.
        </p>
      )}
      {aviso && (
        <p className={`exp-nota ${aviso.tipo === 'error' ? 'is-error' : ''}`} role={aviso.tipo === 'error' ? 'alert' : 'status'}>
          {aviso.texto}
        </p>
      )}
    </div>
  );
}
