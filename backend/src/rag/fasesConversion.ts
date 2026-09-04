/**
 * Vocabulario de fases del pipeline de conversión de UN documento, y cuánto espacio ocupa cada una
 * en la barra de progreso del panel de trabajos.
 *
 * Vive aparte de `ingestaService.ts` porque los conversores (`mdConvertService`,
 * `mineruConvertService`) también tienen que hablarlo, y no pueden importar la ingesta sin cerrar
 * un ciclo de módulos. Es deliberadamente un módulo HOJA: solo tipos y constantes, sin un solo
 * import. Por eso `ProveedorConversion` se define aquí y `conversionProviderService` lo
 * re-exporta, en vez de al revés.
 */

export type ProveedorConversion = 'markitdown' | 'mineru';

export type FaseConversion =
  | 'descargando'         // marcarEstado('en_proceso') + obtenerBytesDocumento (cascada BD → disco)
  | 'generando'           // camino alternativo: PROVEÍDO / HOJA DE ENVÍO armados desde datos del SGD
  | 'deduplicando'        // sha256 + enlazarSiYaExiste (D3: dedup por archivo)
  | 'esperando_circuito'  // el conversor está en reposo: espera muerta, NO hay trabajo en marcha
  | 'en_cola_conversor'   // el semáforo de concurrencia 1 lo tiene otro documento
  | 'convirtiendo'        // la llamada HTTP de verdad
  | 'troceando'           // limpiarMarkdown + trocear
  | 'guardando'           // INSERT del contenido y de los chunks
  | 'listo';              // salida terminal, cualquiera que sea (ok, sin_texto, no_soportado, error)

/**
 * Tramo [inicio, fin] en porcentaje que ocupa cada fase de la barra.
 *
 * NO son proporciones de tiempo real: la conversión se lleva más del 95 % del reloj de pared
 * (hasta 195 s con markitdown, 315 s con mineru; el resto son décimas de segundo). Son
 * proporciones de ESPACIO. La conversión se queda con el 70 % porque es el único tramo que se
 * puede interpolar por tiempo —es el único que conoce su tope— y necesita resolución para moverse
 * suave; los demás son escalones instantáneos que solo tienen que VERSE ocurrir, y por eso se les
 * reserva algo más de lo que su duración justificaría.
 *
 * Tres invariantes sostienen la barra (se verifican en fasesConversion.test.ts):
 *  1. los tramos son contiguos y crecientes ⇒ la barra nunca retrocede al cambiar de fase;
 *  2. `generando` ocupa EXACTAMENTE el mismo tramo que `convirtiendo` (son alternativas del mismo
 *     paso, no dos pasos) ⇒ el camino del documento generado no deja hueco ni salta atrás;
 *  3. `listo` es 100 ⇒ los caminos que no convierten nada (dedup acertado, sin archivo digital)
 *     cierran la barra en vez de dejarla congelada a media asta contando una mentira.
 *
 * `PanelJobIngesta.tsx` mantiene una copia de esta tabla. Si cambian aquí, cambian allí.
 */
export const TRAMOS_FASE: Record<FaseConversion, readonly [number, number]> = {
  descargando: [0, 10],
  deduplicando: [10, 15],
  // Las dos esperas se aparcan al principio del tramo de conversión y no avanzan nada, porque de
  // verdad no está avanzando nada. La UI las distingue con rayas en movimiento, que es la
  // diferencia honesta entre "esperando" y "colgado".
  esperando_circuito: [15, 15],
  en_cola_conversor: [15, 15],
  convirtiendo: [15, 85],
  generando: [15, 85],
  troceando: [85, 93],
  guardando: [93, 100],
  listo: [100, 100],
};

/**
 * Lo que un paso del pipeline le cuenta a quien lo esté observando.
 *
 * Todo es opcional salvo la fase: cada capa rellena solo lo que sabe. El cliente del conversor
 * conoce su propio tope y su circuito; el orquestador del fallback conoce en qué intento de
 * cuántos va y por qué falló el anterior; ninguno de los dos conoce lo del otro.
 */
export interface AvanceFase {
  fase: FaseConversion;
  /** Tope duro de la fase en ms, o `null` si no lo tiene. Es lo que permite interpolar la barra. */
  limiteMs?: number | null;
  proveedor?: ProveedorConversion | null;
  /** 1 = proveedor activo, 2 = respaldo. */
  intento?: number;
  /** Intentos posibles: 1 sin respaldo configurado, 2 con él. */
  intentos?: number;
  /** Por qué se cayó al respaldo. Solo se rellena al ENTRAR al intento 2. */
  motivoFallback?: string | null;
}

/**
 * Observador de fases. Es opcional en todas las firmas a propósito: `repararDocumento` (reintento
 * manual de un documento suelto) y `visionService` llaman al mismo pipeline sin ningún job al que
 * anotarle nada, y no deben tener que inventarse un callback vacío.
 */
export type ReportarFase = (avance: AvanceFase) => void;
