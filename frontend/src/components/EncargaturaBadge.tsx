interface Props {
  tipo: string | null;
  descripcion: string | null;
}

// coTipoEncargatura '1' = Titular, '3' = Enc(e) — confirmado contra
// idosgd.pk_sgd_descripcion_de_dominios('CO_TIPO_ENC', ...) en la BD real.
export function EncargaturaBadge({ tipo, descripcion }: Props) {
  if (!descripcion) return null;

  const className = tipo === '1' ? 'badge badge-titular' : 'badge badge-encargado';

  return <span className={className}>{descripcion}</span>;
}
