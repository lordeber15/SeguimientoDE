interface Props {
  rows?: number;
  columnas?: number;
  etiqueta?: string;
}

// Anchos variados para que el bloque no se lea como una grilla uniforme mientras carga.
const ANCHOS = ['70%', '40%', '80%', '50%', '60%', '45%', '35%'];

export function TableSkeleton({ rows = 6, columnas = 4, etiqueta = 'Cargando datos' }: Props) {
  return (
    <div className="table-card" role="status" aria-live="polite" aria-label={etiqueta}>
      <table>
        <tbody>
          {Array.from({ length: rows }).map((_, fila) => (
            <tr key={fila} className="skeleton-row">
              {Array.from({ length: columnas }).map((__, columna) => (
                <td key={columna}>
                  <div className="skeleton-block" style={{ width: ANCHOS[columna % ANCHOS.length] }} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
