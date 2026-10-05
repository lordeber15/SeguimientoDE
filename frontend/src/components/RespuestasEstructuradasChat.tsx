import type {
  BloqueParticipantesChat,
  DocumentoChat,
  IndicacionDestinoChat,
  MovimientoChat,
  ReferenciaExpediente,
  TarjetaDocumentoChat,
} from '../api/chatComun';

/**
 * Respuestas estructuradas del chat sin modelo (docs/PLAN-CHAT-CONSULTAS.md, Fase 5): la tarjeta
 * del último documento y el bloque de participantes. Todo lo que muestran salió de SQL (y del SGD
 * en vivo al responder), no de una redacción del modelo.
 */

/** "2026-10-02" → "02/10/2026". */
function fecha(iso: string | null): string {
  if (!iso) return 's/f';
  const [a, m, d] = iso.split('-');
  return d && m && a ? `${d}/${m}/${a}` : iso;
}

const destinoTexto = (i: { destino: string | null; persona: string | null }) =>
  [i.destino, i.persona].filter(Boolean).join(' · ') || '—';

function ListaIndicaciones({ indicaciones }: { indicaciones: IndicacionDestinoChat[] }) {
  if (indicaciones.length === 0) return <p className="chat-estructura-vacio">No registra derivaciones.</p>;
  return (
    <ul className="chat-indicaciones">
      {indicaciones.map((i, n) => (
        <li key={n}>
          <span className="chat-indicaciones-destino">→ {destinoTexto(i)}</span>
          <span className="chat-tabla-sub">
            {[i.tramite, i.estado, i.fecha ? fecha(i.fecha) : null].filter(Boolean).join(' · ')}
          </span>
          {i.indicacion && <span className="chat-indicaciones-texto">“{i.indicacion}”</span>}
        </li>
      ))}
    </ul>
  );
}

interface PropsTarjeta {
  documento: TarjetaDocumentoChat;
  onAbrir?: (doc: DocumentoChat) => void;
  onChatear?: (ref: ReferenciaExpediente) => void;
  /** En el modo por expediente no tiene sentido repetir el expediente ni ofrecer "Chatear". */
  mostrarExpediente: boolean;
}

export function TarjetaUltimoDocumento({ documento: d, onAbrir, onChatear, mostrarExpediente }: PropsTarjeta) {
  return (
    <div className="chat-estructura">
      <div className="chat-tarjeta-cabecera">
        <strong>{d.titulo ?? 'Documento'}</strong>
        <span className="chat-tabla-sub">{fecha(d.fecha)}</span>
      </div>
      <dl className="chat-tarjeta-datos">
        {mostrarExpediente && d.numeroExpediente && (
          <>
            <dt>Expediente</dt>
            <dd>{d.numeroExpediente}</dd>
          </>
        )}
        <dt>{d.remitente ? 'Remitente' : 'Emisor'}</dt>
        <dd>{d.remitente ?? d.emisor ?? '—'}</dd>
        {d.asunto && (
          <>
            <dt>Asunto</dt>
            <dd>{d.asunto}</dd>
          </>
        )}
      </dl>

      <h4 className="chat-estructura-titulo">Derivaciones e indicaciones</h4>
      <ListaIndicaciones indicaciones={d.indicaciones} />

      {d.anteriores.length > 0 && (
        <>
          <h4 className="chat-estructura-titulo">Anteriores</h4>
          <ul className="chat-anteriores">
            {d.anteriores.map((a) => (
              <li key={`${a.nuAnn}-${a.nuEmi}`}>
                {fecha(a.fecha)} · {a.titulo ?? 'Documento'}
                {mostrarExpediente && a.numeroExpediente ? ` · ${a.numeroExpediente}` : ''}
                {onAbrir && (
                  <button type="button" className="boton-enlace" onClick={() => onAbrir(a)}>Abrir</button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="chat-tabla-pie">
        {onAbrir && (
          <button type="button" className="boton-secundario" onClick={() => onAbrir(d)}>Abrir documento</button>
        )}
        {onChatear && mostrarExpediente && d.nuAnnExp && (
          <button type="button" className="boton-enlace" onClick={() => onChatear(d)}>Chatear con este expediente</button>
        )}
      </div>
    </div>
  );
}

function Movimiento({ m }: { m: MovimientoChat }) {
  return (
    <li>
      <span className="chat-tabla-sub">{fecha(m.fecha)} · {m.documento ?? 'Documento'}</span>
      <span>
        {m.emisor ?? '—'} → {destinoTexto(m)}
      </span>
      {(m.tramite || m.estado) && (
        <span className="chat-tabla-sub">{[m.tramite, m.estado].filter(Boolean).join(' · ')}</span>
      )}
      {m.indicacion && <span className="chat-indicaciones-texto">“{m.indicacion}”</span>}
    </li>
  );
}

interface PropsParticipantes {
  participantes: BloqueParticipantesChat;
  onChatear?: (ref: ReferenciaExpediente) => void;
}

export function ParticipantesChat({ participantes: b, onChatear }: PropsParticipantes) {
  return (
    <div className="chat-estructura">
      <div className="chat-participantes-grupos">
        <section>
          <h4 className="chat-estructura-titulo">Remitentes externos ({b.remitentes.length})</h4>
          {b.remitentes.length === 0 ? <p className="chat-estructura-vacio">Ninguno.</p> : (
            <ul className="chat-participantes-lista">
              {b.remitentes.map((r) => (
                <li key={r.nombre}>
                  <span>{r.nombre}</span>
                  <span className="chat-tabla-sub">
                    {r.documento ? `${r.documento} · ` : ''}{r.documentos} doc. · {r.expedientes} exp.
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section>
          <h4 className="chat-estructura-titulo">Emisores internos ({b.emisores.length})</h4>
          {b.emisores.length === 0 ? <p className="chat-estructura-vacio">Ninguno.</p> : (
            <ul className="chat-participantes-lista">
              {b.emisores.map((e) => (
                <li key={`${e.dependencia}-${e.empleado}`}>
                  <span>{e.empleado ?? '—'}</span>
                  <span className="chat-tabla-sub">{e.dependencia ?? ''} · {e.documentos} doc. · {e.expedientes} exp.</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section>
          <h4 className="chat-estructura-titulo">Destinatarios ({b.destinatarios.length})</h4>
          {b.destinatarios.length === 0 ? <p className="chat-estructura-vacio">Ninguno.</p> : (
            <ul className="chat-participantes-lista">
              {b.destinatarios.map((d) => (
                <li key={`${d.dependencia}-${d.persona}`}>
                  <span>{d.persona ?? d.dependencia ?? '—'}</span>
                  <span className="chat-tabla-sub">
                    {d.persona && d.dependencia ? `${d.dependencia} · ` : ''}{d.veces} deriv. · {d.expedientes} exp.
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {b.tramites.length > 0 && (
        <>
          <h4 className="chat-estructura-titulo">Trámite e indicaciones</h4>
          {b.tramites.map((t, i) => (
            <details key={`${t.nuAnnExp}-${t.nuSecExp}`} className="chat-tramite" open={b.tramites.length === 1 && i === 0}>
              <summary>
                {t.numeroExpediente ?? `${t.nuAnnExp}-${t.nuSecExp}`} · {t.movimientos.length} movimientos
                {onChatear && b.tramites.length > 1 && (
                  <button
                    type="button"
                    className="boton-enlace"
                    onClick={(e) => { e.preventDefault(); onChatear(t); }}
                  >
                    Chatear
                  </button>
                )}
              </summary>
              <ol className="chat-indicaciones">
                {t.movimientos.map((m, n) => <Movimiento key={n} m={m} />)}
              </ol>
            </details>
          ))}
        </>
      )}
    </div>
  );
}
