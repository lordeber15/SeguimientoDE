import '../compartido/config/env';
import fs from 'fs';
import { QueryTypes, type Sequelize } from 'sequelize';
import { z } from 'zod';
import { appSequelize } from '../compartido/config/appDatabase';
import { crearChatProvider } from '../compartido/ai/providerFactory';
import type { ChatProvider } from '../compartido/ai/types';
import {
  cargarCasos,
  esquemaArchivoCasos,
  MODULOS,
  normalizar,
  rutaCasos,
  type CasoRag,
  type ModuloEval,
} from '../compartido/rag/evaluacionRag';
import { extraerJson } from '../compartido/rag/planificadorService';
import { stdRagSequelize } from '../modulos/std/config/stdRagDatabase';

/**
 * Siembra BORRADORES de casos de evaluación del RAG (docs/PLAN-RAG-AVANZADO.md, Fase 1) y los agrega
 * a `evals/casos.<modulo>.json` con `"revisado": false` — `eval:rag` los ignora hasta que una persona
 * los revise (corrija la pregunta o el `ground_truth`, o borre el caso) y lo cambie a `true`.
 *
 *   npm run eval:rag:semilla -- --modulo sgd --sinteticos 40
 *   npm run eval:rag:semilla -- --modulo sgd --sinteticos 0 --historial
 *
 * Dos fuentes:
 * - `--sinteticos N`: N fragmentos reales al azar (uno por documento); el modelo de chat escribe una
 *   pregunta que un usuario haría, su respuesta y una frase LITERAL del fragmento como evidencia. Si
 *   la evidencia no está de verdad en el fragmento, el caso se descarta. La etiqueta de relevancia
 *   (documento + evidencia) sale gratis: es el fragmento del que se generó.
 * - `--historial` (solo SGD): preguntas reales del chat que obtuvieron respuesta con citas usadas; los
 *   documentos citados quedan como relevantes y la respuesta que se dio, como `ground_truth`
 *   provisional — es lo que MÁS hay que revisar.
 *
 * No toca los casos que ya existen (mismo id = se salta).
 */

const MIN_CHARS_FRAGMENTO = 900;

interface FragmentoMuestra {
  sha256: string;
  texto: string;
  ruta_titulos: string | null;
  tipo_doc: string | null;
  asunto: string | null;
  /** SGD */
  nu_ann?: string;
  nu_emi?: string;
  nu_ane?: number | null;
  /** STD */
  id_adjunto?: number;
}

async function muestrear(modulo: ModuloEval, n: number): Promise<FragmentoMuestra[]> {
  const db: Sequelize = modulo === 'sgd' ? appSequelize : stdRagSequelize;
  const columnasDoc = modulo === 'sgd' ? 'd.nu_ann, d.nu_emi, d.nu_ane' : 'd.id_adjunto';
  // TABLESAMPLE en vez de ORDER BY random() sobre toda la tabla (cientos de miles de chunks); el 2 %
  // sobra para N pequeños, y si no alcanza se reintenta con más.
  for (const porcentaje of [2, 10, 50]) {
    const filas = await db.query<FragmentoMuestra>(
      `SELECT DISTINCT ON (c.sha256) c.sha256, c.texto, c.ruta_titulos, d.tipo_doc, d.asunto, ${columnasDoc}
         FROM rag.chunk c TABLESAMPLE BERNOULLI (${porcentaje})
         JOIN LATERAL (
           SELECT * FROM rag.documento d
            WHERE d.contenido_sha256 = c.sha256 AND d.vigente
            LIMIT 1
         ) d ON true
        WHERE length(c.texto) >= $1
        LIMIT $2`,
      { bind: [MIN_CHARS_FRAGMENTO, n * 4], type: QueryTypes.SELECT },
    );
    if (filas.length >= n || porcentaje === 50) {
      return filas.sort(() => Math.random() - 0.5).slice(0, n * 2); // margen para los descartados
    }
  }
  return [];
}

const PROMPT_SINTETICO = `Generas casos de prueba para un buscador de documentos de trámite \
documentario de una entidad pública peruana (oficios, informes, cartas, contratos, resoluciones). \
Recibes UN fragmento de un documento. Devuelve SOLO un objeto JSON, sin texto antes ni después:

{"pregunta": "…", "respuesta": "…", "evidencia": "…", "tipo": "factual" | "codigo" | "jerga"}

- "pregunta": lo que un funcionario preguntaría al buscador para obtener un DATO concreto de este \
fragmento (monto, plazo, fecha, motivo, responsable, número de documento, conclusión…). Debe \
incluir lo necesario para identificar el caso sin ver el fragmento (la obra, la empresa, el número \
de contrato o de documento, el lugar), porque se buscará entre cientos de miles de documentos. \
Nunca digas "según el fragmento" ni "este documento".
- "tipo": "codigo" si la pregunta gira en torno a un identificador literal (N° de oficio, de \
contrato, RUC, código); "jerga" si la redactas con palabras coloquiales distintas de las del \
documento ("plata" por "monto", "la empresa que alquila" por "el arrendador"); si no, "factual". \
Varía: no siempre "factual".
- "respuesta": la respuesta correcta y breve, solo con lo que dice el fragmento.
- "evidencia": una frase COPIADA LITERALMENTE del fragmento, de 4 a 15 palabras, que contenga el \
dato de la respuesta.
Si el fragmento no tiene ningún dato concreto preguntable (índice, firma, texto ilegible), devuelve \
{"pregunta": null}.`;

const esquemaSintetico = z.object({
  pregunta: z.string().min(10),
  respuesta: z.string().min(2),
  evidencia: z.string().min(10),
  tipo: z.enum(['factual', 'codigo', 'jerga']).catch('factual'),
});

async function generarSintetico(
  provider: ChatProvider,
  modulo: ModuloEval,
  f: FragmentoMuestra,
): Promise<CasoRag | null> {
  const encabezado = [f.tipo_doc, f.asunto, f.ruta_titulos].filter(Boolean).join(' · ');
  const respuesta = await provider.responder(
    [
      { rol: 'system', contenido: PROMPT_SINTETICO },
      { rol: 'user', contenido: `Documento: ${encabezado || '(sin metadatos)'}\n\nFragmento:\n${f.texto}` },
    ],
    { maxTokens: 400 },
  );
  const r = esquemaSintetico.safeParse(extraerJson(respuesta.texto));
  if (!r.success) return null;
  // La evidencia debe estar de verdad en el fragmento: si el modelo la parafraseó, la etiqueta no sirve.
  if (!normalizar(f.texto).includes(normalizar(r.data.evidencia))) return null;

  const documento = modulo === 'sgd'
    ? { nuAnn: f.nu_ann!, nuEmi: f.nu_emi!, ...(f.nu_ane !== null && f.nu_ane !== undefined ? { nuAne: f.nu_ane } : {}) }
    : { idAdjunto: Number(f.id_adjunto) };

  return {
    id: `sint-${f.sha256.slice(0, 10)}`,
    pregunta: r.data.pregunta,
    historial: [],
    ground_truth: r.data.respuesta,
    relevantes: { documentos: [documento], evidencias: [r.data.evidencia] },
    sin_respuesta: false,
    tipo: r.data.tipo,
    origen: 'sintetico',
    revisado: false,
  };
}

/** Preguntas reales del chat del SGD con respuesta de texto y al menos una cita usada. */
async function desdeHistorial(limite: number): Promise<CasoRag[]> {
  const filas = await appSequelize.query<{
    mensaje_id: number; pregunta: string; respuesta: string;
    documentos: { nuAnn: string; nuEmi: string; nuAne: number | null }[];
  }>(
    `SELECT a.id AS mensaje_id, u.texto AS pregunta, a.texto AS respuesta,
            json_agg(DISTINCT jsonb_build_object('nuAnn', d.nu_ann, 'nuEmi', d.nu_emi, 'nuAne', d.nu_ane)) AS documentos
       FROM rag.chat_mensaje a
       JOIN rag.chat_sesion s ON s.id = a.sesion_id AND s.modo = 'general'
       JOIN LATERAL (
         SELECT texto FROM rag.chat_mensaje u
          WHERE u.sesion_id = a.sesion_id AND u.rol = 'user' AND u.id < a.id
          ORDER BY u.id DESC LIMIT 1
       ) u ON true
       JOIN rag.cita ci ON ci.mensaje_id = a.id AND ci.usada
       JOIN rag.documento d ON d.id = ci.documento_id
      WHERE a.rol = 'assistant' AND a.tipo = 'texto' AND length(u.texto) >= 15
      GROUP BY a.id, u.texto, a.texto
      ORDER BY a.id DESC
      LIMIT $1`,
    { bind: [limite], type: QueryTypes.SELECT },
  );
  return filas.map((f) => ({
    id: `hist-${f.mensaje_id}`,
    pregunta: f.pregunta.trim(),
    historial: [],
    ground_truth: f.respuesta.replace(/\[D\d+\]/g, '').trim(),
    relevantes: {
      documentos: f.documentos.map((d) => ({ nuAnn: d.nuAnn, nuEmi: d.nuEmi, ...(d.nuAne !== null ? { nuAne: d.nuAne } : {}) })),
      evidencias: [],
    },
    sin_respuesta: false,
    tipo: 'factual' as const,
    origen: 'historial' as const,
    revisado: false,
    nota: 'ground_truth = la respuesta que dio el chat: verifíquela contra el documento antes de revisar.',
  }));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const valor = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const modulo = (valor('--modulo') ?? 'sgd') as ModuloEval;
  if (!MODULOS.includes(modulo)) throw new Error(`--modulo debe ser ${MODULOS.join(' o ')}`);
  const sinteticos = Math.max(0, Number(valor('--sinteticos') ?? 20) || 0);
  const conHistorial = argv.includes('--historial');
  if (conHistorial && modulo !== 'sgd') throw new Error('--historial solo aplica al SGD (el chat del STD aún no tiene historial útil)');

  const archivo = rutaCasos(modulo);
  const existentes = fs.existsSync(archivo) ? cargarCasos(archivo).casos : [];
  const ids = new Set(existentes.map((c) => c.id));
  const nuevos: CasoRag[] = [];
  const agregar = (c: CasoRag) => {
    if (ids.has(c.id)) return false;
    ids.add(c.id);
    nuevos.push(c);
    return true;
  };

  if (conHistorial) {
    const hist = await desdeHistorial(50);
    const agregados = hist.filter(agregar).length;
    console.log(`Historial: ${agregados} casos nuevos (de ${hist.length} preguntas con citas).`);
  }

  if (sinteticos > 0) {
    const provider = crearChatProvider();
    const muestra = await muestrear(modulo, sinteticos);
    let generados = 0;
    let descartados = 0;
    for (const f of muestra) {
      if (generados >= sinteticos) break;
      try {
        const caso = await generarSintetico(provider, modulo, f);
        if (caso && agregar(caso)) {
          generados++;
          console.log(`  + ${caso.id} [${caso.tipo}] ${caso.pregunta}`);
        } else {
          descartados++;
        }
      } catch (e) {
        descartados++;
        console.log(`  ! ${f.sha256.slice(0, 10)}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    console.log(`Sintéticos: ${generados} generados, ${descartados} descartados (sin dato o evidencia no literal).`);
  }

  const salida = esquemaArchivoCasos.parse({ modulo, casos: [...existentes, ...nuevos] });
  fs.writeFileSync(archivo, `${JSON.stringify(salida, null, 2)}\n`, 'utf8');
  console.log(`\n${nuevos.length} borradores agregados a ${archivo} (total ${salida.casos.length}).`);
  console.log('Revíselos y cambie "revisado" a true en los que sirvan; eval:rag ignora los demás.');
}

main().then(() => process.exit(0), (e) => {
  console.error(e);
  process.exit(1);
});
