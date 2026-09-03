interface Props {
  codigo: string | null;
  descripcion: string | null;
}

// Códigos de IDOSGD.TDTR_ESTADOS con DE_TAB='TDTV_DESTINOS' (verificado en la BD real).
// El color acompaña al texto, nunca lo reemplaza — regla color-not-decorative-only.
const CLASE_POR_CODIGO: Record<string, string> = {
  '0': 'badge-pendiente', // NO LEIDO
  '1': 'badge-progreso', // RECIBIDO
  '2': 'badge-atendido', // ATENDIDO
  '3': 'badge-neutro', // ARCHIVADO
  '4': 'badge-progreso', // DERIVADO
  '5': 'badge-progreso', // ENVIADO
  '9': 'badge-anulado', // ANULADO
};

export function EstadoBadge({ codigo, descripcion }: Props) {
  if (!descripcion) return <span className="celda-vacia">—</span>;

  const clase = (codigo && CLASE_POR_CODIGO[codigo]) ?? 'badge-neutro';

  return <span className={`badge ${clase}`}>{descripcion}</span>;
}
