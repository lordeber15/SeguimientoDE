import { QueryTypes } from 'sequelize';
import { appSequelize } from '../config/appDatabase';
import { DB_SCHEMA, sequelize } from '../config/database';

const S = DB_SCHEMA;

/** Mismo umbral que se documentó en PLAN-DASHBOARD-DESEMPENO.md §9 al proponer la metodología:
 *  con menos de 5 atendidos, la mediana de tiempo es demasiado ruidosa para sugerir un peso. */
const MUESTRA_MINIMA = 5;

export interface PesoTipoDocumento {
  coTipDoc: string;
  descripcion: string | null;
  /** Peso vigente — `1` si nadie lo ajustó todavía (sin fila en `tipo_documento_peso`). */
  peso: number;
  /** `null` si la muestra de atendidos de este tipo es menor que `MUESTRA_MINIMA`. */
  pesoSugerido: number | null;
  muestraAtendidos: number;
  medianaHoras: number | null;
  actualizadoPor: string | null;
  feActualizado: string | null;
}

interface FilaPeso {
  coTipDoc: string;
  muestraAtendidos: string;
  medianaSegundos: number | null;
  pesoSugerido: number | null;
  peso: string;
  actualizadoPor: string | null;
  feActualizado: string | null;
}

/**
 * Catálogo de pesos por tipo de documento (Fase 3), con la sugerencia de peso inicial —
 * metodología documentada en PLAN-DASHBOARD-DESEMPENO.md §9: percentil del tiempo mediano de
 * atención de ese tipo dentro del conjunto de tipos con muestra suficiente
 * (`PERCENT_RANK() OVER (ORDER BY mediana)`), desplazado a `1 + percentil` — el tipo más rápido
 * sugiere ~1.0, el más lento ~2.0. Tipos sin muestra suficiente igual aparecen (por si ya tienen
 * un peso puesto a mano o para poder ponérselo), solo que sin sugerencia.
 *
 * Corre contra `dashboard.participacion` (el espejo, no el SGD) — mismo motivo que el resto de
 * `dashboardService.ts`: es la única fuente rápida de tiempos de atención por tipo de documento.
 */
export async function listarPesos(): Promise<PesoTipoDocumento[]> {
  const filas = await appSequelize.query<FilaPeso>(
    `WITH universo AS (
      SELECT DISTINCT co_tip_doc FROM dashboard.participacion
       WHERE co_tip_doc IS NOT NULL AND NOT es_informativo
      UNION
      SELECT co_tip_doc FROM dashboard.tipo_documento_peso
    ),
    stats AS (
      SELECT co_tip_doc,
        count(*) AS muestra,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY segundos_corridos) AS mediana_segundos
      FROM dashboard.participacion
      WHERE NOT es_informativo AND atendido AND segundos_corridos IS NOT NULL
      GROUP BY co_tip_doc
    ),
    rango AS (
      SELECT co_tip_doc, PERCENT_RANK() OVER (ORDER BY mediana_segundos) AS percentil
      FROM stats
      WHERE muestra >= $1
    )
    SELECT
      u.co_tip_doc AS "coTipDoc",
      COALESCE(s.muestra, 0)::text AS "muestraAtendidos",
      s.mediana_segundos AS "medianaSegundos",
      CASE WHEN r.co_tip_doc IS NOT NULL THEN 1 + r.percentil END AS "pesoSugerido",
      COALESCE(w.peso, 1)::text AS peso,
      w.actualizado_por AS "actualizadoPor",
      w.fe_actualizado::text AS "feActualizado"
    FROM universo u
    LEFT JOIN stats s ON s.co_tip_doc = u.co_tip_doc
    LEFT JOIN rango r ON r.co_tip_doc = u.co_tip_doc
    LEFT JOIN dashboard.tipo_documento_peso w ON w.co_tip_doc = u.co_tip_doc
    ORDER BY s.mediana_segundos DESC NULLS LAST, u.co_tip_doc`,
    { bind: [MUESTRA_MINIMA], type: QueryTypes.SELECT },
  );

  const descripciones = await mapaDescripciones();

  return filas.map((f) => ({
    coTipDoc: f.coTipDoc,
    descripcion: descripciones.get(f.coTipDoc) ?? null,
    peso: Number(f.peso),
    pesoSugerido: f.pesoSugerido !== null ? Math.round(Number(f.pesoSugerido) * 100) / 100 : null,
    muestraAtendidos: Number(f.muestraAtendidos),
    medianaHoras: f.medianaSegundos !== null ? Math.round((Number(f.medianaSegundos) / 3600) * 100) / 100 : null,
    actualizadoPor: f.actualizadoPor,
    feActualizado: f.feActualizado,
  }));
}

/** Catálogo real del SGD — igual que `dashboardService.tiposDocumento`, duplicado a propósito
 *  (es una consulta liviana, no vale la pena compartir una función entre los dos servicios por
 *  esto solo) — aquí solo para mostrar la descripción junto al código en la pantalla de pesos. */
async function mapaDescripciones(): Promise<Map<string, string | null>> {
  const tipos = await sequelize.query<{ codigo: string; descripcion: string | null }>(
    `SELECT cdoc_tipdoc AS codigo, cdoc_desdoc AS descripcion FROM ${S}.si_mae_tipo_doc`,
    { type: QueryTypes.SELECT },
  );
  return new Map(tipos.map((t) => [t.codigo, t.descripcion]));
}

/**
 * Fija a mano el peso de un tipo de documento — sobrescribe la sugerencia (o el `1` por defecto).
 * Queda registrado en la propia fila (`actualizado_por`/`fe_actualizado`) y en `app.auditoria`,
 * mismo criterio que `rag/configService.escribirConfig`: cambia cómo se lee la productividad de
 * todos, así que debe quedar rastro de quién lo tocó y cuándo.
 */
export async function actualizarPeso(coTipDoc: string, peso: number, actor: string): Promise<void> {
  await appSequelize.query(
    `INSERT INTO dashboard.tipo_documento_peso (co_tip_doc, peso, actualizado_por, fe_actualizado)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (co_tip_doc) DO UPDATE SET peso = $2, actualizado_por = $3, fe_actualizado = now()`,
    { bind: [coTipDoc, peso, actor], type: QueryTypes.INSERT },
  );

  await appSequelize.query(
    `INSERT INTO app.auditoria (actor, accion, detalle) VALUES ($1, 'dashboard.peso.cambiar', $2::jsonb)`,
    { bind: [actor, JSON.stringify({ coTipDoc, peso })], type: QueryTypes.INSERT },
  );
}
