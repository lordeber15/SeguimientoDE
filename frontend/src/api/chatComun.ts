/**
 * Formas mínimas compartidas entre el chat del SGD (`api/chat.ts`) y el chat del STD (`api/std.ts`)
 * — lo que `ChatPage.tsx` y los componentes de cita (`CitaBadge`, `RespuestaConCitas`) necesitan
 * para funcionar sobre CUALQUIERA de los dos sistemas, sin conocer sus campos propios (expediente
 * frente a N° STD). `ChatPage` se parametriza con un `AdaptadorChat<E, C>` en vez de duplicarse:
 * ver la cabecera de `ChatPage.tsx`.
 */

/** Lo que `CitaBadge`/`ListaCitas` necesitan de una cita — ni `CitaChat` (SGD) ni `CitaChatStd`
 *  traen nada menos que esto, así que ambas satisfacen esta forma sin conversión. */
export interface CitaBasica {
  numero: number;
  chunkId: number;
  extracto: string;
  chars: number;
  rutaTitulos: string | null;
  usada: boolean;
}

export interface EstadoIngestaBase {
  total: number;
  listos: number;
  convertidos: number;
  pendientes: number;
  sinTexto: number;
  error: number;
  noSoportado: number;
  completo: boolean;
}

/** 'fijo' = mensaje de cierre sin LLM (fuera de alcance, ayuda, sin resultados). Opcional: el
 *  chat STD todavía no lo envía. */
export type TipoRespuestaChat = 'texto' | 'tabla' | 'fijo';

export interface RespuestaChatBase<C extends CitaBasica> {
  sesionId: number;
  mensajeId: number;
  tipo?: TipoRespuestaChat;
  texto: string;
  citas: C[];
  candidatosVec: number;
  candidatosFts: number;
  marcadoresAlucinados: number;
}

export interface MensajeHistorialBase<C extends CitaBasica> {
  id: number;
  rol: 'user' | 'assistant';
  tipo?: TipoRespuestaChat;
  texto: string;
  citas: C[];
}

/**
 * Todo lo que varía entre el chat del SGD (por expediente) y el del STD (por N° STD): de dónde
 * salen los datos, cómo se buscan y etiquetan, y cómo se abre el documento citado. `E` es el tipo
 * de la entidad elegida en el buscador (expediente o documento STD); `C`, el tipo de cita de ese
 * sistema.
 */
export interface AdaptadorChat<E, C extends CitaBasica> {
  sistema: 'sgd' | 'std';
  etiquetaPestanaGeneral: string;
  etiquetaPestanaContexto: string;
  notaGeneral: string;
  labelBusqueda: string;
  placeholderBusqueda: string;
  notaVacioGeneral: string;
  notaVacioSinSeleccion: string;
  notaVacioConSeleccion: string;
  notaSinResultados: string;
  /** "expediente" / "documento" — para el aviso de cobertura ("N de M documentos de este
   *  {sustantivoContexto} están indexados"). */
  sustantivoContexto: string;

  claveEntidad(e: E): string;
  etiquetaEntidad(e: E): string;
  descripcionResultado(e: E): string;

  buscar(termino: string): Promise<E[]>;
  fetchSesion(e: E): Promise<{ id: number } | null>;
  fetchEstadoIngesta(e: E): Promise<EstadoIngestaBase>;
  fetchHistorial(sesionId: number): Promise<MensajeHistorialBase<C>[]>;
  enviarGeneral(mensaje: string, sesionId?: number): Promise<RespuestaChatBase<C>>;
  enviarContexto(e: E, mensaje: string, sesionId?: number): Promise<RespuestaChatBase<C>>;
  fetchTexto(chunkId: number): Promise<{ texto: string }>;
  abrirCita(cita: C): { url: string; titulo: string; visualizable: boolean };

  /** Permiso que habilita el enlace "Documentos (n)" hacia el panel de gestión. */
  permisoGestionar: string;
}
