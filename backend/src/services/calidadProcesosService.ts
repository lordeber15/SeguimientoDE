import { QueryTypes } from 'sequelize';
import { appSequelize } from '../config/appDatabase';
import { leerNumero } from '../rag/configService';

/**
 * Vista "Calidad de procesos" — el agregado multi-expediente que faltaba.
 *
 * Todo corre contra el espejo local (`dashboard.paso`, `dashboard.proceso*`), nunca contra el SGD:
 * el emparejamiento caro ya se pagó en el refresco (`dashboardResumenService`).
 *
 * Dos ideas centrales, ambas verificadas contra la BD real (ver docs/PLAN-CALIDAD-PROCESOS.md §2):
 *
 *  - **La traza de un expediente** es la secuencia de oficinas por las que pasó, colapsando
 *    repeticiones consecutivas de la misma oficina (los saltos internos jefe→especialista viven
 *    dentro del nodo, no como pasos propios).
 *  - **La columna vertebral** es el camino de mayor frecuencia por el grafo "directamente-sigue",
 *    NO la secuencia exacta más repetida. La diferencia es enorme y es lo que hace útil la vista:
 *    en "pago de consultoría" (436 expedientes) la ruta exacta más repetida cubre el 13%, mientras
 *    que la columna vertebral `OGA → Logística → Contabilidad → Tesorería` está presente, en ese
 *    orden, en el 91,3%. La dispersión estaba solo en un desvío opcional de conformidad al inicio.
 */

export interface FiltroProcesos {
  desde?: string;
  hasta?: string;
  /** Expedientes que pasaron por esta oficina en algún momento de su recorrido. */
  coDependencia?: string;
  /** Por defecto `true`: un expediente a medio camino tiene una ruta truncada y ensucia el
   *  cálculo de la columna vertebral. Verificado ✅ 2026-09-02: con solo cerrados la cobertura de
   *  la columna sube de 60,8% a 76,4%. */
  soloCerrados?: boolean;
}

/** Estado `'3'` ARCHIVADO en `TDTV_DESTINOS`: el cierre explícito del trámite. */
const ESTADO_ARCHIVADO = '3';

interface FilaPaso {
  procesoClave: string;
  nuAnnExp: string;
  nuSecExp: string;
  coDepEmi: string | null;
  coDepDes: string;
  nombreDependencia: string | null;
  coMot: string | null;
  coTipDoc: string | null;
  esDocRec: string | null;
  segundosTotal: string | null;
  segundosEspera: string | null;
  segundosTrabajo: string | null;
}

interface Traza {
  clave: string;
  procesoClave: string;
  /** Códigos de oficina, en orden, sin repeticiones consecutivas. */
  ruta: string[];
  pasos: FilaPaso[];
  cerrado: boolean;
}

// ── Utilidades numéricas ────────────────────────────────────────────────────────────────────────

/** Percentil por interpolación lineal, igual criterio que `PERCENTILE_CONT` de Postgres — para que
 *  un mismo número calculado aquí y en SQL no difiera. */
export function percentil(valores: number[], p: number): number | null {
  if (valores.length === 0) return null;
  const orden = [...valores].sort((a, b) => a - b);
  if (orden.length === 1) return orden[0];
  const posicion = (orden.length - 1) * Math.min(Math.max(p, 0), 1);
  const bajo = Math.floor(posicion);
  const alto = Math.ceil(posicion);
  if (bajo === alto) return orden[bajo];
  return orden[bajo] + (orden[alto] - orden[bajo]) * (posicion - bajo);
}

function redondear(valor: number | null, decimales = 2): number | null {
  if (valor === null || !Number.isFinite(valor)) return null;
  const factor = 10 ** decimales;
  return Math.round(valor * factor) / factor;
}

const aHoras = (segundos: number | null): number | null =>
  segundos === null ? null : redondear(segundos / 3600);

// ── Trazas y columna vertebral ──────────────────────────────────────────────────────────────────

/** Agrupa los pasos por expediente y arma su traza. Los pasos llegan ya ordenados por la consulta
 *  (`fe_envio, nu_emi, nu_des`), el mismo orden canónico que `getInteraccionesExpediente`. */
export function construirTrazas(filas: FilaPaso[]): Traza[] {
  const porExpediente = new Map<string, FilaPaso[]>();
  for (const fila of filas) {
    const clave = `${fila.nuAnnExp}|${fila.nuSecExp}`;
    const lista = porExpediente.get(clave);
    if (lista) lista.push(fila);
    else porExpediente.set(clave, [fila]);
  }

  const trazas: Traza[] = [];
  for (const [clave, pasos] of porExpediente) {
    const ruta: string[] = [];
    // El primer emisor abre la traza: es por donde ENTRÓ el expediente (mesa de partes, o la
    // oficina que lo originó). Sin esto el flujograma arrancaría en el segundo nodo.
    if (pasos[0].coDepEmi) ruta.push(pasos[0].coDepEmi);
    for (const paso of pasos) {
      if (ruta[ruta.length - 1] !== paso.coDepDes) ruta.push(paso.coDepDes);
    }
    trazas.push({
      clave,
      procesoClave: pasos[0].procesoClave,
      ruta,
      pasos,
      cerrado: pasos[pasos.length - 1].esDocRec === ESTADO_ARCHIVADO,
    });
  }
  return trazas;
}

/** ¿Aparecen todos los elementos de `sub`, en ese orden (no necesariamente seguidos), dentro de
 *  `ruta`? Es la definición de "este expediente siguió la columna vertebral": puede haber dado
 *  rodeos, pero pasó por las etapas troncales en el orden correcto. */
export function contieneSubsecuencia(ruta: string[], sub: string[]): boolean {
  let i = 0;
  for (const nodo of ruta) {
    if (nodo === sub[i]) i += 1;
    if (i === sub.length) return true;
  }
  return i === sub.length;
}

/** Fracción mínima de expedientes que debe recorrer un arco para entrar en la columna vertebral.
 *  Por debajo, el "camino principal" empezaría a seguir rodeos de unos pocos casos. */
const MINIMO_ARCO = 0.15;
const MAXIMO_NODOS = 15;
/** Cuántas veces seguidas se acepta "volver por una oficina ya vista" para retomar el tronco. */
const MAXIMO_PUENTES = 3;

/**
 * Camino de mayor frecuencia por el grafo "directamente-sigue": arranca en la oficina de entrada
 * más común y, en cada paso, sigue el arco recorrido por más expedientes distintos.
 *
 * **Ningún nodo se repite en el resultado.** Sin esa restricción, una devolución frecuente (A→B→A)
 * haría que el camino oscilara entre dos oficinas para siempre en vez de avanzar. Pero prohibir sin
 * más volver a pisar un nodo ya visto trunca los procesos con una oficina EJE por la que el
 * expediente pasa entre etapa y etapa (`OGA → oficina técnica → OGA → Logística → …`): al llegar a
 * un nodo cuya única salida es el eje, el camino se quedaría corto. Por eso, cuando el nodo actual
 * no tiene ninguna salida hacia un nodo NUEVO, se permite volver por uno ya visitado —un "puente",
 * que no se vuelve a añadir al camino— y seguir buscando desde allí. Cada puente se usa una sola
 * vez y hay un tope, así que no puede ciclar.
 */
export function columnaVertebral(trazas: Traza[]): string[] {
  if (trazas.length === 0) return [];

  // Arcos medidos en EXPEDIENTES distintos, no en repeticiones: un expediente que rebota tres veces
  // entre dos oficinas no debe pesar como tres.
  const arcos = new Map<string, Set<string>>();
  for (const traza of trazas) {
    for (let i = 0; i < traza.ruta.length - 1; i += 1) {
      const clave = `${traza.ruta[i]} ${traza.ruta[i + 1]}`;
      const set = arcos.get(clave);
      if (set) set.add(traza.clave);
      else arcos.set(clave, new Set([traza.clave]));
    }
  }

  const entradas = new Map<string, number>();
  for (const traza of trazas) {
    if (traza.ruta.length === 0) continue;
    entradas.set(traza.ruta[0], (entradas.get(traza.ruta[0]) ?? 0) + 1);
  }
  if (entradas.size === 0) return [];

  const inicio = [...entradas].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
  const camino = [inicio];
  const visitados = new Set(camino);
  const puentesUsados = new Set<string>();
  const minimo = Math.max(2, trazas.length * MINIMO_ARCO);

  /** El arco mas recorrido que sale de `origen` hacia un destino que cumpla `aceptar`, o `null` si
   *  ninguno llega al minimo. Desempata por codigo de oficina para que el resultado no dependa del
   *  orden de iteracion del Map. */
  function mejorSalida(origen: string, aceptar: (destino: string) => boolean): string | null {
    let elegido: string | null = null;
    let mejor = 0;
    for (const [clave, expedientes] of arcos) {
      const separador = clave.indexOf(' ');
      if (clave.slice(0, separador) !== origen) continue;
      const destino = clave.slice(separador + 1);
      if (!aceptar(destino)) continue;
      if (expedientes.size > mejor || (expedientes.size === mejor && elegido !== null && destino < elegido)) {
        mejor = expedientes.size;
        elegido = destino;
      }
    }
    return elegido !== null && mejor >= minimo ? elegido : null;
  }

  let actual = inicio;
  let puentes = 0;

  while (camino.length < MAXIMO_NODOS) {
    const nuevoNodo = mejorSalida(actual, (destino) => !visitados.has(destino));
    if (nuevoNodo !== null) {
      camino.push(nuevoNodo);
      visitados.add(nuevoNodo);
      actual = nuevoNodo;
      puentes = 0;
      continue;
    }

    // Sin salida hacia un nodo nuevo: se vuelve por una oficina ya vista (tipicamente el eje) y se
    // sigue buscando desde ahi, sin volver a agregarla al camino.
    if (puentes >= MAXIMO_PUENTES) break;
    const puente = mejorSalida(
      actual,
      (destino) =>
        visitados.has(destino) && destino !== actual && !puentesUsados.has(`${actual} ${destino}`),
    );
    if (puente === null) break;
    puentesUsados.add(`${actual} ${puente}`);
    actual = puente;
    puentes += 1;
  }

  return camino;
}

// ── Carga desde el espejo ───────────────────────────────────────────────────────────────────────

/**
 * Construye el `WHERE` sobre los EXPEDIENTES, no sobre los pasos — distinción importante: si el
 * rango de fechas filtrara paso a paso, un expediente que empezó antes del rango aparecería con la
 * traza cortada por la mitad y el flujograma mostraría un proceso que empieza en el medio. Aquí el
 * filtro elige expedientes (por la fecha de su primer paso) y luego se cargan TODOS sus pasos.
 *
 * Sin filtro de tipo de documento a propósito: un proceso atraviesa varios tipos (la solicitud es
 * un oficio, la conformidad un informe, el pago un memorando), y acotar a uno truncaría el flujo de
 * la misma forma que lo haría el rango de fechas mal aplicado.
 */
function construirFiltro(filtro: FiltroProcesos): { whereSql: string; binds: unknown[] } {
  const binds: unknown[] = [];
  const condiciones: string[] = [];

  if (filtro.desde) {
    binds.push(filtro.desde);
    condiciones.push(`o.fe_origen >= $${binds.length}`);
  }
  if (filtro.hasta) {
    binds.push(filtro.hasta);
    condiciones.push(`o.fe_origen < $${binds.length}::date + interval '1 day'`);
  }
  if (filtro.coDependencia) {
    binds.push(filtro.coDependencia);
    condiciones.push(
      `EXISTS (SELECT 1 FROM dashboard.paso x
                WHERE x.nu_ann_exp = o.nu_ann_exp AND x.nu_sec_exp = o.nu_sec_exp
                  AND NOT x.es_informativo AND x.co_dep_des = $${binds.length})`,
    );
  }

  return { whereSql: condiciones.length > 0 ? condiciones.join(' AND ') : 'true', binds };
}

/**
 * El CTE `elegidos` — expedientes que pasan el filtro y ya tienen familia asignada — es el punto de
 * partida tanto de `cargarPasos` (los pasos a nivel oficina) como de `cargarParticipacionesProceso`
 * (el desglose por persona dentro de un nodo). Factorizado para que ambas consultas seleccionen
 * exactamente el mismo conjunto de expedientes: si divergieran, el desglose por persona de un nodo
 * podría no sumar lo mismo que su propia fila agregada.
 */
function construirCteElegidos(
  filtro: FiltroProcesos,
  procesoClave: string | undefined,
): { cteSql: string; binds: unknown[] } {
  const { whereSql, binds } = construirFiltro(filtro);
  let condicionProceso = '';
  if (procesoClave) {
    binds.push(procesoClave);
    condicionProceso = ` AND pe.proceso_clave = $${binds.length}`;
  }

  const cteSql = `
    origen AS (
      SELECT nu_ann_exp, nu_sec_exp, min(fe_envio) AS fe_origen
        FROM dashboard.paso
       WHERE NOT es_informativo
       GROUP BY nu_ann_exp, nu_sec_exp
    ),
    elegidos AS (
      SELECT o.nu_ann_exp, o.nu_sec_exp, pe.proceso_clave
        FROM origen o
        JOIN dashboard.proceso_expediente pe
          ON pe.nu_ann_exp = o.nu_ann_exp AND pe.nu_sec_exp = o.nu_sec_exp
       WHERE ${whereSql}${condicionProceso}
    )`;

  return { cteSql, binds };
}

/** Carga los pasos de acción de todos los expedientes elegidos, en el orden canónico.
 *  `procesoClave` opcional acota a una sola familia. */
async function cargarPasos(filtro: FiltroProcesos, procesoClave?: string): Promise<FilaPaso[]> {
  const { cteSql, binds } = construirCteElegidos(filtro, procesoClave);

  return appSequelize.query<FilaPaso>(
    `WITH ${cteSql}
     SELECT e.proceso_clave AS "procesoClave",
            p.nu_ann_exp AS "nuAnnExp", p.nu_sec_exp AS "nuSecExp",
            p.co_dep_emi AS "coDepEmi", p.co_dep_des AS "coDepDes",
            p.nombre_dependencia AS "nombreDependencia",
            p.co_mot AS "coMot", p.co_tip_doc AS "coTipDoc", p.es_doc_rec AS "esDocRec",
            p.segundos_total::text AS "segundosTotal",
            p.segundos_espera::text AS "segundosEspera",
            p.segundos_trabajo::text AS "segundosTrabajo"
       FROM dashboard.paso p
       JOIN elegidos e ON e.nu_ann_exp = p.nu_ann_exp AND e.nu_sec_exp = p.nu_sec_exp
      WHERE NOT p.es_informativo
      ORDER BY p.nu_ann_exp, p.nu_sec_exp, p.fe_envio, p.nu_emi, p.nu_des`,
    { bind: binds, type: QueryTypes.SELECT },
  );
}

interface FilaParticipacionNodo {
  nuAnnExp: string;
  nuSecExp: string;
  coDepDes: string;
  coEmpDes: string;
  nombreEmpleado: string | null;
  segundosCorridos: string | null;
}

/**
 * Desglose por PERSONA dentro de cada oficina del proceso — lo que se ve al expandir un nodo del
 * flujograma. Distinto de `cargarPasos`: viene de `dashboard.participacion` (emparejado por
 * EMPLEADO, ver `dashboardResumenService.leerParticipacionesSgd`), no de `dashboard.paso`
 * (emparejado por oficina) — es la misma tabla que ya usa el resto del dashboard para medir a las
 * personas, reutilizada aquí en vez de duplicar ese emparejamiento una tercera vez.
 *
 * Restringido a los MISMOS expedientes que `cargarPasos` (mismo CTE `elegidos`): así la suma de
 * visitas por persona de un nodo coincide con las visitas totales que ya muestra ese nodo.
 */
async function cargarParticipacionesProceso(
  filtro: FiltroProcesos,
  procesoClave: string,
): Promise<FilaParticipacionNodo[]> {
  const { cteSql, binds } = construirCteElegidos(filtro, procesoClave);

  return appSequelize.query<FilaParticipacionNodo>(
    `WITH ${cteSql}
     SELECT part.nu_ann_exp AS "nuAnnExp", part.nu_sec_exp AS "nuSecExp",
            part.co_dep_des AS "coDepDes", part.co_emp_des AS "coEmpDes",
            part.nombre_empleado AS "nombreEmpleado",
            part.segundos_corridos::text AS "segundosCorridos"
       FROM dashboard.participacion part
       JOIN elegidos e ON e.nu_ann_exp = part.nu_ann_exp AND e.nu_sec_exp = part.nu_sec_exp
      WHERE NOT part.es_informativo`,
    { bind: binds, type: QueryTypes.SELECT },
  );
}

/** Nombres de oficina, tomados del propio espejo (ya desnormalizados en el refresco) — no hace
 *  falta ir al SGD ni cruzar entre bases. Incluye las oficinas que solo aparecen como emisoras. */
async function nombresDependencia(): Promise<Map<string, string>> {
  const filas = await appSequelize.query<{ co: string; nombre: string | null }>(
    `SELECT co_dep_des AS co, max(nombre_dependencia) AS nombre
       FROM dashboard.paso GROUP BY co_dep_des`,
    { type: QueryTypes.SELECT },
  );
  return new Map(filas.filter((f) => f.nombre).map((f) => [f.co, f.nombre as string]));
}

function filtrarCerrados(trazas: Traza[], filtro: FiltroProcesos): Traza[] {
  return filtro.soloCerrados === false ? trazas : trazas.filter((t) => t.cerrado);
}

// ── 1. Listado de procesos descubiertos ─────────────────────────────────────────────────────────

export interface ResumenProceso {
  clave: string;
  nombre: string;
  /** `true` si el nombre viene de `dashboard.proceso_alias` (alguien lo renombró a mano). */
  renombrado: boolean;
  expedientes: number;
  pasosPromedio: number | null;
  duracionMedianaHoras: number | null;
  nodosColumna: number;
  /** % de expedientes que recorren la columna vertebral en orden. */
  coberturaColumna: number | null;
  /** % de expedientes que siguen la ruta exacta más repetida — la comparación que motivó usar la
   *  columna vertebral en vez de la ruta exacta. */
  coberturaRutaExacta: number | null;
}

export async function listarProcesos(filtro: FiltroProcesos): Promise<ResumenProceso[]> {
  const muestraMinima = await leerNumero('calidad.proceso.muestra_minima', 5);
  const [filas, alias] = await Promise.all([cargarPasos(filtro), leerAlias()]);

  const trazas = filtrarCerrados(construirTrazas(filas), filtro);
  const porProceso = new Map<string, Traza[]>();
  for (const traza of trazas) {
    const lista = porProceso.get(traza.procesoClave);
    if (lista) lista.push(traza);
    else porProceso.set(traza.procesoClave, [traza]);
  }

  const nombres = await leerNombresProceso();
  const resumenes: ResumenProceso[] = [];

  for (const [clave, grupo] of porProceso) {
    if (grupo.length < muestraMinima) continue;

    const columna = columnaVertebral(grupo);
    const enColumna =
      columna.length >= 2 ? grupo.filter((t) => contieneSubsecuencia(t.ruta, columna)).length : 0;

    const rutas = new Map<string, number>();
    for (const traza of grupo) {
      const firma = traza.ruta.join('>');
      rutas.set(firma, (rutas.get(firma) ?? 0) + 1);
    }
    const masRepetida = Math.max(...rutas.values());

    const duraciones = grupo
      .map((t) => duracionTotal(t))
      .filter((d): d is number => d !== null);

    resumenes.push({
      clave,
      nombre: alias.get(clave) ?? nombres.get(clave) ?? clave,
      renombrado: alias.has(clave),
      expedientes: grupo.length,
      pasosPromedio: redondear(grupo.reduce((n, t) => n + t.pasos.length, 0) / grupo.length),
      duracionMedianaHoras: aHoras(percentil(duraciones, 0.5)),
      nodosColumna: columna.length,
      coberturaColumna: columna.length >= 2 ? redondear((100 * enColumna) / grupo.length, 1) : null,
      coberturaRutaExacta: redondear((100 * masRepetida) / grupo.length, 1),
    });
  }

  return resumenes.sort((a, b) => b.expedientes - a.expedientes);
}

/** Suma del tiempo de todos los pasos del expediente — "cuánto tardó el trámite completo". Es una
 *  suma de tiempos de atención, no la diferencia entre la primera y la última fecha: los tramos
 *  sin respuesta emparejada no se cuentan, ni a favor ni en contra. */
function duracionTotal(traza: Traza): number | null {
  let total = 0;
  let alguno = false;
  for (const paso of traza.pasos) {
    if (paso.segundosTotal === null) continue;
    total += Number(paso.segundosTotal);
    alguno = true;
  }
  return alguno ? total : null;
}

async function leerNombresProceso(): Promise<Map<string, string>> {
  const filas = await appSequelize.query<{ clave: string; nombre: string }>(
    'SELECT clave, nombre_auto AS nombre FROM dashboard.proceso',
    { type: QueryTypes.SELECT },
  );
  return new Map(filas.map((f) => [f.clave, f.nombre]));
}

async function leerAlias(): Promise<Map<string, string>> {
  const filas = await appSequelize.query<{ clave: string; nombre: string }>(
    'SELECT proceso_clave AS clave, nombre FROM dashboard.proceso_alias',
    { type: QueryTypes.SELECT },
  );
  return new Map(filas.map((f) => [f.clave, f.nombre]));
}

// ── 2. Flujo actual ─────────────────────────────────────────────────────────────────────────────

export interface NodoFlujo {
  orden: number;
  coDependencia: string;
  nombreDependencia: string;
  /** Expedientes de la familia que pasaron por esta oficina. */
  expedientes: number;
  cobertura: number;
  visitas: number;
  medianaHoras: number | null;
  p25Horas: number | null;
  p75Horas: number | null;
  esperaMedianaHoras: number | null;
  trabajoMedianaHoras: number | null;
  motivos: { codigo: string | null; visitas: number }[];
  /** Desglose por persona — lo que se ve al expandir el nodo. Ordenado por visitas desc; hasta 8
   *  (una oficina grande puede tener decenas de empleados, y la cola larga no aporta a la lectura). */
  porEmpleado: { coEmpleado: string; nombre: string | null; visitas: number; medianaHoras: number | null }[];
}

export interface PasoOpcional {
  coDependencia: string;
  nombreDependencia: string;
  expedientes: number;
  cobertura: number;
  medianaHoras: number | null;
  p25Horas: number | null;
}

export interface FlujoProceso {
  clave: string;
  nombre: string;
  expedientes: number;
  columna: NodoFlujo[];
  coberturaColumna: number | null;
  /** La ruta exacta más repetida, que se muestra debajo del diagrama junto a su conteo. */
  rutaExacta: { oficinas: string[]; expedientes: number; cobertura: number } | null;
  rutasDistintas: number;
  /** Oficinas por las que pasa una parte relevante de los expedientes pero que no entran en la
   *  columna vertebral (ninguna sola supera al resto). Aquí vive, por ejemplo, la conformidad
   *  técnica del pago de consultoría: cinco oficinas alternativas que cubren ~70% entre todas. */
  opcionales: PasoOpcional[];
}

/** Un desvío entra en "pasos opcionales" si lo recorre al menos este % de los expedientes — por
 *  debajo es ruido de casos sueltos, no una etapa del proceso. */
const MINIMO_OPCIONAL = 3;

export async function flujoProceso(
  clave: string,
  filtro: FiltroProcesos,
): Promise<FlujoProceso | null> {
  const [filas, participaciones, alias, nombres, nombresDep] = await Promise.all([
    cargarPasos(filtro, clave),
    cargarParticipacionesProceso(filtro, clave),
    leerAlias(),
    leerNombresProceso(),
    nombresDependencia(),
  ]);

  const trazas = filtrarCerrados(construirTrazas(filas), filtro);
  if (trazas.length === 0) return null;

  // Desglose por persona, indexado por oficina. El CTE `elegidos` (compartido con `cargarPasos`)
  // ya filtró por fecha/oficina/proceso en SQL, pero NO por "solo cerrados" — ese filtro se aplica
  // en JS sobre las trazas de `dashboard.paso` (arriba), así que aquí hay que descartar a mano las
  // participaciones de expedientes que ese filtro dejó fuera.
  const expedientesFiltrados = new Set(trazas.map((t) => t.clave));
  const empleadosPorOficina = new Map<
    string,
    Map<string, { nombre: string | null; visitas: number; tiempos: number[] }>
  >();
  for (const p of participaciones) {
    if (!expedientesFiltrados.has(`${p.nuAnnExp}|${p.nuSecExp}`)) continue;

    let porEmpleado = empleadosPorOficina.get(p.coDepDes);
    if (!porEmpleado) {
      porEmpleado = new Map();
      empleadosPorOficina.set(p.coDepDes, porEmpleado);
    }
    const acc = porEmpleado.get(p.coEmpDes) ?? { nombre: p.nombreEmpleado, visitas: 0, tiempos: [] };
    acc.visitas += 1;
    if (p.segundosCorridos !== null) acc.tiempos.push(Number(p.segundosCorridos));
    porEmpleado.set(p.coEmpDes, acc);
  }

  const columna = columnaVertebral(trazas);
  const enColumna =
    columna.length >= 2 ? trazas.filter((t) => contieneSubsecuencia(t.ruta, columna)).length : 0;

  const nombreDe = (co: string): string => nombresDep.get(co) ?? co;

  // Estadísticas por oficina, sobre TODOS los pasos (un expediente puede visitar la misma oficina
  // varias veces; cada visita aporta su tiempo, pero la cobertura cuenta expedientes distintos).
  const porOficina = new Map<
    string,
    { expedientes: Set<string>; total: number[]; espera: number[]; trabajo: number[]; motivos: Map<string | null, number>; visitas: number }
  >();
  for (const traza of trazas) {
    for (const paso of traza.pasos) {
      let acc = porOficina.get(paso.coDepDes);
      if (!acc) {
        acc = { expedientes: new Set(), total: [], espera: [], trabajo: [], motivos: new Map(), visitas: 0 };
        porOficina.set(paso.coDepDes, acc);
      }
      acc.expedientes.add(traza.clave);
      acc.visitas += 1;
      acc.motivos.set(paso.coMot, (acc.motivos.get(paso.coMot) ?? 0) + 1);
      if (paso.segundosTotal !== null) acc.total.push(Number(paso.segundosTotal));
      if (paso.segundosEspera !== null) acc.espera.push(Number(paso.segundosEspera));
      if (paso.segundosTrabajo !== null) acc.trabajo.push(Number(paso.segundosTrabajo));
    }
  }

  const nodos: NodoFlujo[] = columna.map((co, i) => {
    const acc = porOficina.get(co);
    return {
      orden: i + 1,
      coDependencia: co,
      nombreDependencia: nombreDe(co),
      expedientes: acc?.expedientes.size ?? 0,
      cobertura: redondear((100 * (acc?.expedientes.size ?? 0)) / trazas.length, 1) ?? 0,
      visitas: acc?.visitas ?? 0,
      medianaHoras: aHoras(percentil(acc?.total ?? [], 0.5)),
      p25Horas: aHoras(percentil(acc?.total ?? [], 0.25)),
      p75Horas: aHoras(percentil(acc?.total ?? [], 0.75)),
      esperaMedianaHoras: aHoras(percentil(acc?.espera ?? [], 0.5)),
      trabajoMedianaHoras: aHoras(percentil(acc?.trabajo ?? [], 0.5)),
      motivos: [...(acc?.motivos ?? [])]
        .map(([codigo, visitas]) => ({ codigo, visitas }))
        .sort((a, b) => b.visitas - a.visitas)
        .slice(0, 3),
      porEmpleado: [...(empleadosPorOficina.get(co) ?? [])]
        .map(([coEmpleado, e]) => ({
          coEmpleado,
          nombre: e.nombre,
          visitas: e.visitas,
          medianaHoras: aHoras(percentil(e.tiempos, 0.5)),
        }))
        .sort((a, b) => b.visitas - a.visitas)
        .slice(0, 8),
    };
  });

  const enColumnaSet = new Set(columna);
  const opcionales: PasoOpcional[] = [...porOficina]
    .filter(([co, acc]) => !enColumnaSet.has(co) && (100 * acc.expedientes.size) / trazas.length >= MINIMO_OPCIONAL)
    .map(([co, acc]) => ({
      coDependencia: co,
      nombreDependencia: nombreDe(co),
      expedientes: acc.expedientes.size,
      cobertura: redondear((100 * acc.expedientes.size) / trazas.length, 1) ?? 0,
      medianaHoras: aHoras(percentil(acc.total, 0.5)),
      p25Horas: aHoras(percentil(acc.total, 0.25)),
    }))
    .sort((a, b) => b.expedientes - a.expedientes);

  const rutas = new Map<string, number>();
  for (const traza of trazas) {
    const firma = traza.ruta.join('>');
    rutas.set(firma, (rutas.get(firma) ?? 0) + 1);
  }
  const mejorRuta = [...rutas].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];

  return {
    clave,
    nombre: alias.get(clave) ?? nombres.get(clave) ?? clave,
    expedientes: trazas.length,
    columna: nodos,
    coberturaColumna: columna.length >= 2 ? redondear((100 * enColumna) / trazas.length, 1) : null,
    rutaExacta: mejorRuta
      ? {
          oficinas: mejorRuta[0].split('>').map(nombreDe),
          expedientes: mejorRuta[1],
          cobertura: redondear((100 * mejorRuta[1]) / trazas.length, 1) ?? 0,
        }
      : null,
    rutasDistintas: rutas.size,
    opcionales,
  };
}

// ── 3. Propuesta de mejora ──────────────────────────────────────────────────────────────────────

export interface PasoPropuesta {
  orden: number;
  coDependencia: string;
  nombreDependencia: string;
  actualMedianaHoras: number | null;
  objetivoHoras: number | null;
  /** De dónde sale el objetivo: el universo comparable entre todas las oficinas, o —cuando ese
   *  universo no tiene muestra suficiente— el propio mejor cuartil de esta oficina. */
  origenObjetivo: 'comparable' | 'propio' | null;
  /** Oficina que hoy logra el mejor tiempo mediano en el universo comparable. */
  mejorOficina: { coDependencia: string; nombreDependencia: string; medianaHoras: number } | null;
  minimoObservadoHoras: number | null;
  muestra: number;
  ahorroHoras: number | null;
}

export interface Propuesta {
  clave: string;
  nombre: string;
  percentilObjetivo: number;
  pasos: PasoPropuesta[];
  totalActualHoras: number | null;
  totalPropuestoHoras: number | null;
  ahorroHoras: number | null;
  ahorroPorcentaje: number | null;
}

interface FilaComparable {
  coMot: string | null;
  coTipDoc: string | null;
  coDepDes: string;
  segundos: string;
}

/**
 * Universo comparable: todos los pasos del espejo agrupados por `(co_mot, co_tip_doc)` — "mismo
 * tipo de tarea sobre mismo tipo de documento", sin importar el área ni el proceso.
 *
 * `co_mot` es lo más cercano a "qué trabajo se pidió" que existe en el SGD (30 motivos reales:
 * TRAMITAR, EVALUAR, PROYECTAR RESOLUCIÓN, SUBSANAR OBSERVACIONES…), poblado al 97,2% ✅.
 * Sin esta clave, comparar "la conformidad de USEI" contra "el paso de Logística" mezclaría
 * trabajos distintos y produciría metas inalcanzables.
 */
async function universoComparable(): Promise<FilaComparable[]> {
  return appSequelize.query<FilaComparable>(
    `SELECT co_mot AS "coMot", co_tip_doc AS "coTipDoc", co_dep_des AS "coDepDes",
            segundos_total::text AS segundos
       FROM dashboard.paso
      WHERE NOT es_informativo AND segundos_total IS NOT NULL`,
    { type: QueryTypes.SELECT },
  );
}

export async function propuestaMejora(
  clave: string,
  filtro: FiltroProcesos,
): Promise<Propuesta | null> {
  const [flujo, comparables, muestraMinima, percentilObjetivo, filas, nombresDep] = await Promise.all([
    flujoProceso(clave, filtro),
    universoComparable(),
    leerNumero('calidad.proceso.muestra_minima', 5),
    leerNumero('calidad.objetivo.percentil', 10),
    cargarPasos(filtro, clave),
    nombresDependencia(),
  ]);
  if (!flujo) return null;

  // Índice del universo comparable: (motivo, tipo) → tiempos, y (motivo, tipo, oficina) → tiempos.
  const porTarea = new Map<string, number[]>();
  const porTareaOficina = new Map<string, Map<string, number[]>>();
  for (const fila of comparables) {
    const tarea = `${fila.coMot ?? ''} ${fila.coTipDoc ?? ''}`;
    const segundos = Number(fila.segundos);
    const lista = porTarea.get(tarea);
    if (lista) lista.push(segundos);
    else porTarea.set(tarea, [segundos]);

    let oficinas = porTareaOficina.get(tarea);
    if (!oficinas) {
      oficinas = new Map();
      porTareaOficina.set(tarea, oficinas);
    }
    const propia = oficinas.get(fila.coDepDes);
    if (propia) propia.push(segundos);
    else oficinas.set(fila.coDepDes, [segundos]);
  }

  // Qué tareas hace cada oficina DENTRO de este proceso: el objetivo de un nodo se calcula sobre
  // las tareas que realmente ejecuta ahí, no sobre todo lo que esa oficina hace en su vida.
  const tareasDelNodo = new Map<string, Map<string, number>>();
  for (const fila of filas) {
    const tarea = `${fila.coMot ?? ''} ${fila.coTipDoc ?? ''}`;
    let mapa = tareasDelNodo.get(fila.coDepDes);
    if (!mapa) {
      mapa = new Map();
      tareasDelNodo.set(fila.coDepDes, mapa);
    }
    mapa.set(tarea, (mapa.get(tarea) ?? 0) + 1);
  }

  const p = Math.min(Math.max(percentilObjetivo, 0), 100) / 100;
  const pasos: PasoPropuesta[] = flujo.columna.map((nodo) => {
    // La tarea dominante de este nodo en este proceso.
    const tareas = tareasDelNodo.get(nodo.coDependencia);
    const tarea = tareas ? [...tareas].sort((a, b) => b[1] - a[1])[0][0] : null;
    const universo = tarea ? porTarea.get(tarea) ?? [] : [];

    let objetivo: number | null = null;
    let origen: 'comparable' | 'propio' | null = null;
    let mejorOficina: PasoPropuesta['mejorOficina'] = null;

    if (universo.length >= muestraMinima) {
      objetivo = percentil(universo, p);
      origen = 'comparable';

      const oficinas = tarea ? porTareaOficina.get(tarea) : undefined;
      if (oficinas) {
        let mejor: { co: string; mediana: number } | null = null;
        for (const [co, valores] of oficinas) {
          if (valores.length < muestraMinima) continue;
          const mediana = percentil(valores, 0.5);
          if (mediana !== null && (mejor === null || mediana < mejor.mediana)) mejor = { co, mediana };
        }
        if (mejor) {
          mejorOficina = {
            coDependencia: mejor.co,
            nombreDependencia: nombresDep.get(mejor.co) ?? mejor.co,
            medianaHoras: aHoras(mejor.mediana) ?? 0,
          };
        }
      }
    } else if (nodo.p25Horas !== null) {
      // Sin universo comparable suficiente, la meta es el propio mejor cuartil de esta oficina:
      // menos ambicioso, pero imposible de objetar y siempre alcanzable.
      objetivo = nodo.p25Horas * 3600;
      origen = 'propio';
    }

    const objetivoHoras = aHoras(objetivo);
    const ahorro =
      nodo.medianaHoras !== null && objetivoHoras !== null && objetivoHoras < nodo.medianaHoras
        ? redondear(nodo.medianaHoras - objetivoHoras)
        : null;

    return {
      orden: nodo.orden,
      coDependencia: nodo.coDependencia,
      nombreDependencia: nodo.nombreDependencia,
      actualMedianaHoras: nodo.medianaHoras,
      objetivoHoras,
      origenObjetivo: origen,
      mejorOficina,
      minimoObservadoHoras: universo.length > 0 ? aHoras(Math.min(...universo)) : null,
      muestra: universo.length,
      ahorroHoras: ahorro,
    };
  });

  const totalActual = sumaDefinida(pasos.map((x) => x.actualMedianaHoras));
  // Un paso sin objetivo se propone tal como está hoy: la propuesta nunca "mejora" algo que no supo
  // medir, ni lo descuenta del total.
  const totalPropuesto = sumaDefinida(
    pasos.map((x) =>
      x.objetivoHoras !== null && x.actualMedianaHoras !== null
        ? Math.min(x.objetivoHoras, x.actualMedianaHoras)
        : x.actualMedianaHoras,
    ),
  );

  return {
    clave,
    nombre: flujo.nombre,
    percentilObjetivo,
    pasos,
    totalActualHoras: redondear(totalActual),
    totalPropuestoHoras: redondear(totalPropuesto),
    ahorroHoras:
      totalActual !== null && totalPropuesto !== null ? redondear(totalActual - totalPropuesto) : null,
    ahorroPorcentaje:
      totalActual !== null && totalPropuesto !== null && totalActual > 0
        ? redondear((100 * (totalActual - totalPropuesto)) / totalActual, 1)
        : null,
  };
}

function sumaDefinida(valores: (number | null)[]): number | null {
  const definidos = valores.filter((v): v is number => v !== null);
  return definidos.length === 0 ? null : definidos.reduce((a, b) => a + b, 0);
}

// ── 4. Renombrar una familia ────────────────────────────────────────────────────────────────────

export async function renombrarProceso(
  clave: string,
  nombre: string,
  actor: string,
): Promise<void> {
  await appSequelize.query(
    `INSERT INTO dashboard.proceso_alias (proceso_clave, nombre, actualizado_por, fe_actualizado)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (proceso_clave)
     DO UPDATE SET nombre = EXCLUDED.nombre,
                   actualizado_por = EXCLUDED.actualizado_por,
                   fe_actualizado = now()`,
    { bind: [clave, nombre, actor], type: QueryTypes.INSERT },
  );

  // Mismo rastro que `dashboardPesosService.actualizarPeso` y `configService.escribirConfig`:
  // renombrar una familia cambia lo que ve todo el mundo, no es una preferencia personal.
  await appSequelize.query(
    'INSERT INTO app.auditoria (actor, accion, detalle) VALUES ($1, $2, $3::jsonb)',
    {
      bind: [actor, 'calidad.proceso.renombrar', JSON.stringify({ clave, nombre })],
      type: QueryTypes.INSERT,
    },
  );
}
