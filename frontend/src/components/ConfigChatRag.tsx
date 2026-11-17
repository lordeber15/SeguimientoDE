import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { apiJson } from '../api/cliente';

/**
 * Interruptores del chat y vocabulario de dominio de un módulo (docs/PLAN-RAG-AVANZADO.md, Fase 4).
 * Común al panel del SGD (`/api/rag`) y al del STD (`/api/std/rag`): ambos exponen el mismo
 * `GET /config` y `PUT /config/:clave`, cada uno sobre su propia BD.
 */

interface FilaConfig {
  clave: string;
  valor: string;
}

const INTERRUPTORES: { clave: string; titulo: string; nota: string; porDefecto: boolean }[] = [
  {
    clave: 'chat.planificador.activo',
    titulo: 'Planificador',
    nota: 'Clasifica y reescribe cada pregunta antes de buscar (listados, conteos, seguimientos). Apagado, todo va a la búsqueda de contenido.',
    porDefecto: true,
  },
  {
    clave: 'chat.descomposicion.activa',
    titulo: 'Preguntas compuestas',
    nota: 'Divide las preguntas que piden varias cosas en subconsultas y busca cada una. Solo cuesta búsquedas, no tokens.',
    porDefecto: true,
  },
  {
    clave: 'chat.hyde.activo',
    titulo: 'HyDE',
    nota: 'Busca también por un párrafo hipotético redactado por el modelo rápido. Suma una llamada corta por pregunta: actívelo si la evaluación muestra mejora.',
    porDefecto: false,
  },
];

const EJEMPLO_SINONIMOS = '{\n  "alquiler": ["arrendamiento"],\n  "computadoras": ["equipos de cómputo"]\n}';

function formatear(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

export function ConfigChatRag({ base }: { base: '/api/rag' | '/api/std/rag' }) {
  const [valores, setValores] = useState<Record<string, string> | null>(null);
  const [sinonimos, setSinonimos] = useState('');
  const [guardando, setGuardando] = useState<string | null>(null);

  useEffect(() => {
    apiJson<FilaConfig[]>(`${base}/config`, 'leer la configuración del chat')
      .then((filas) => {
        const mapa = Object.fromEntries(filas.map((f) => [f.clave, f.valor]));
        setValores(mapa);
        setSinonimos(formatear(mapa['chat.sinonimos'] ?? '{}'));
      })
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'No se pudo leer la configuración del chat'));
  }, [base]);

  async function guardar(clave: string, valor: string, exito: string) {
    setGuardando(clave);
    try {
      await apiJson(`${base}/config/${clave}`, `guardar ${clave}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ valor }),
      });
      setValores((v) => ({ ...(v ?? {}), [clave]: valor }));
      toast.success(exito);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `No se pudo guardar ${clave}`);
    } finally {
      setGuardando(null);
    }
  }

  function guardarSinonimos() {
    try {
      JSON.parse(sinonimos);
    } catch {
      toast.error('El vocabulario no es JSON válido. Formato: {"término": ["alternativa", …]}');
      return;
    }
    void guardar('chat.sinonimos', JSON.stringify(JSON.parse(sinonimos)), 'Vocabulario guardado.');
  }

  if (!valores) return <p className="exp-nota">Cargando configuración del chat…</p>;

  const activo = (clave: string, porDefecto: boolean) =>
    valores[clave] === undefined ? porDefecto : valores[clave] === 'true';

  return (
    <div className="rag-acciones">
      {INTERRUPTORES.map((i) => (
        <div key={i.clave}>
          <label className="checkbox-linea">
            <input
              type="checkbox"
              checked={activo(i.clave, i.porDefecto)}
              disabled={guardando === i.clave}
              onChange={(e) => guardar(i.clave, String(e.target.checked), `${i.titulo}: ${e.target.checked ? 'activado' : 'desactivado'}.`)}
            />
            <span>
              {i.titulo}
              <span className="exp-nota">{i.nota}</span>
            </span>
          </label>
        </div>
      ))}

      <div className="config-chat-vocabulario">
        <label htmlFor={`sinonimos-${base}`}>
          Vocabulario de dominio
          <span className="exp-nota">
            Jerga → formas oficiales de los documentos. Se usa en la búsqueda por texto, en los listados y,
            desde la Fase 4, también en la búsqueda semántica. Claves sin tildes ni mayúsculas.
          </span>
        </label>
        <textarea
          id={`sinonimos-${base}`}
          className="config-chat-textarea"
          rows={8}
          spellCheck={false}
          value={sinonimos}
          placeholder={EJEMPLO_SINONIMOS}
          onChange={(e) => setSinonimos(e.target.value)}
        />
        <button
          className="boton-secundario"
          onClick={guardarSinonimos}
          disabled={guardando === 'chat.sinonimos'}
          aria-busy={guardando === 'chat.sinonimos'}
        >
          {guardando === 'chat.sinonimos' && <span className="boton-spinner" aria-hidden="true" />}
          {guardando === 'chat.sinonimos' ? 'Guardando…' : 'Guardar vocabulario'}
        </button>
      </div>
    </div>
  );
}
