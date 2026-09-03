import { limpiarMarkdown } from '../../src/rag/limpiezaService';

describe('limpiarMarkdown', () => {
  it('elimina data URIs base64 de imágenes', () => {
    const base64 = 'A'.repeat(5000);
    const bruto = `Antes\n\n![img](data:image/png;base64,${base64})\n\nDespués`;
    const { markdown, dataUrisEliminados } = limpiarMarkdown(bruto);

    expect(markdown).not.toContain('base64');
    expect(markdown).toContain('Antes');
    expect(markdown).toContain('Después');
    expect(dataUrisEliminados).toBeGreaterThan(0);
  });

  it('no se cuelga con un data URI grande (protección de backtracking)', () => {
    const base64 = 'A'.repeat(3 * 1024 * 1024); // 3 MB, como el caso real que motivó esto
    const bruto = `texto ![x](data:image/png;base64,${base64}) más texto`;

    const inicio = Date.now();
    const { markdown } = limpiarMarkdown(bruto);
    expect(Date.now() - inicio).toBeLessThan(1000);
    expect(markdown).not.toContain('AAAA');
  });

  it('une palabras partidas por guion de fin de línea', () => {
    const { markdown } = limpiarMarkdown('La adminis-\ntración pública resolvió...');
    expect(markdown).toContain('administración');
    expect(markdown).not.toContain('adminis-');
  });

  it('no une un guion legítimo seguido de mayúscula', () => {
    const { markdown } = limpiarMarkdown('Lima-\nCallao son sedes distintas');
    // "Lima-\nCallao": la letra siguiente es mayúscula, no se debe fusionar como si fuera corte de palabra.
    expect(markdown).toContain('Lima-');
  });

  it('elimina líneas repetidas en ≥60% de las páginas (membretes/pies)', () => {
    const paginas = Array.from({ length: 6 }, (_, i) => `MEMBRETE OFICIAL UE118\n\nContenido único ${i}\n\nPág. X`);
    const bruto = paginas.join('\n---\n');

    const { markdown, lineasRepetidasEliminadas } = limpiarMarkdown(bruto);

    expect(markdown).not.toContain('MEMBRETE OFICIAL UE118');
    expect(markdown).toContain('Contenido único 0');
    expect(lineasRepetidasEliminadas).toBeGreaterThan(0);
  });

  it('no elimina nada si hay pocas páginas (evita falsos positivos en documentos cortos)', () => {
    const bruto = 'MEMBRETE\n\ncontenido\n---\nMEMBRETE\n\notro contenido';
    const { markdown } = limpiarMarkdown(bruto);
    expect(markdown).toContain('MEMBRETE');
  });

  it('marca sin_texto cuando queda muy poco tras limpiar', () => {
    expect(limpiarMarkdown('').sinTexto).toBe(true);
    expect(limpiarMarkdown('   \n\n  ').sinTexto).toBe(true);
    expect(limpiarMarkdown('x'.repeat(10)).sinTexto).toBe(true);
    expect(limpiarMarkdown('x'.repeat(500)).sinTexto).toBe(false);
  });

  it('recorta espacios finales y colapsa saltos de línea excesivos', () => {
    const { markdown } = limpiarMarkdown('Línea 1   \n\n\n\n\nLínea 2');
    expect(markdown).not.toMatch(/ +\n/);
    expect(markdown).not.toMatch(/\n{3,}/);
  });
});
