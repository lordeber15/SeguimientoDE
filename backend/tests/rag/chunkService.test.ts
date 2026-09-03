import { construirCabecera, estimarTokens, trocear } from '../../src/rag/chunkService';

describe('trocear', () => {
  it('agrupa párrafos cortos en un solo chunk sin partirlos innecesariamente', () => {
    const md = ['# Título', '', 'Párrafo uno.', '', 'Párrafo dos.', '', 'Párrafo tres.'].join('\n');
    const chunks = trocear(md);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].texto).toContain('Párrafo uno');
    expect(chunks[0].texto).toContain('Párrafo tres');
  });

  it('parte un documento largo en varios chunks con solape', () => {
    // Cada párrafo ~50 tokens; con TOKENS_OBJETIVO=700 hacen falta muchos para partir.
    const parrafos = Array.from({ length: 60 }, (_, i) =>
      `Considerando número ${i}: la entidad resuelve aprobar la solicitud presentada por el administrado conforme al expediente correspondiente y a la normativa vigente aplicable en la materia.`);
    const chunks = trocear(parrafos.join('\n\n'));

    expect(chunks.length).toBeGreaterThan(1);
    // Los ord son consecutivos desde 0.
    expect(chunks.map((c) => c.ord)).toEqual(chunks.map((_, i) => i));

    // Hay solape real: el final de un chunk reaparece al principio del siguiente.
    const finDelPrimero = chunks[0].texto.slice(-80);
    const inicioSegmento = finDelPrimero.split(' ').slice(-5).join(' ');
    expect(chunks[1].texto).toContain(inicioSegmento);
  });

  it('ningún chunk queda vacío ni con solo espacios', () => {
    const chunks = trocear('# H\n\n\n\n   \n\ntexto real\n\n\n');
    expect(chunks.every((c) => c.texto.trim().length > 0)).toBe(true);
  });

  it('conserva la ruta de títulos (VISTOS > CONSIDERANDO)', () => {
    const md = ['# VISTOS', '', 'el expediente tal.', '', '## CONSIDERANDO', '', 'que corresponde aprobar.'].join('\n');
    const chunks = trocear(md);

    const conConsiderando = chunks.find((c) => c.texto.includes('corresponde aprobar'));
    expect(conConsiderando?.rutaTitulos).toContain('CONSIDERANDO');
  });

  it('no parte dentro de una tabla Markdown', () => {
    const filas = Array.from({ length: 5 }, (_, i) => `| ${i} | Concepto ${i} | ${i * 100} |`);
    const tabla = ['| N | Concepto | Monto |', '|---|---|---|', ...filas].join('\n');
    const md = `Texto antes.\n\n${tabla}\n\nTexto después.`;

    const chunks = trocear(md);
    const conTabla = chunks.find((c) => c.texto.includes('Concepto 0'));
    // La tabla completa (todas sus filas) debe estar en el mismo chunk que su cabecera.
    expect(conTabla?.texto).toContain('Concepto 4');
    expect(conTabla?.texto).toContain('| N | Concepto | Monto |');
  });

  it('una tabla más grande que el objetivo se parte por filas repitiendo la cabecera', () => {
    const filas = Array.from({ length: 400 }, (_, i) =>
      `| ${i} | Concepto administrativo número ${i} con descripción algo más larga | S/ ${i * 137}.00 |`);
    const tabla = ['| N | Concepto | Monto |', '|---|---|---|', ...filas].join('\n');

    const chunks = trocear(tabla);

    expect(chunks.length).toBeGreaterThan(1);
    // Cada trozo de la tabla partida repite la cabecera: sin ella, un trozo es cifras sin contexto.
    for (const c of chunks) {
      expect(c.texto).toContain('| N | Concepto | Monto |');
    }
  });

  it('un párrafo sin puntuación (OCR malo) más grande que el objetivo no se pierde', () => {
    const gigante = 'palabra '.repeat(2000).trim(); // sin puntos, ~16000 caracteres
    const chunks = trocear(gigante);

    expect(chunks.length).toBeGreaterThan(1);
    const total = chunks.reduce((n, c) => n + c.texto.replace(/\s+/g, ' ').length, 0);
    // No se debe perder texto de forma significativa al cortar a lo bruto.
    expect(total).toBeGreaterThan(gigante.length * 0.9);
  });

  it('carInicio/carFin son coherentes con la posición del texto', () => {
    const md = 'Primer bloque.\n\nSegundo bloque más largo para separar bien las cosas.';
    const chunks = trocear(md);
    for (const c of chunks) {
      expect(c.carFin).toBeGreaterThan(c.carInicio);
    }
  });

  it('devuelve una lista vacía para un documento vacío', () => {
    expect(trocear('')).toEqual([]);
    expect(trocear('   \n\n  ')).toEqual([]);
  });
});

describe('estimarTokens', () => {
  it('crece con la longitud del texto', () => {
    expect(estimarTokens('a'.repeat(350))).toBeGreaterThan(estimarTokens('a'.repeat(35)));
  });

  it('un texto vacío es 0 tokens', () => {
    expect(estimarTokens('')).toBe(0);
  });
});

describe('construirCabecera', () => {
  it('compone los campos presentes separados por " · "', () => {
    const cab = construirCabecera({
      titulo: 'INFORME N° 29-2026-OGA-UL',
      numeroExpediente: 'OGAUL020260000058',
      dependencia: 'OGA-UL',
      fecha: '13/05/2026',
      asunto: 'Proyección de gasto',
      rutaTitulos: 'CONSIDERANDO',
    });

    expect(cab).toBe(
      'INFORME N° 29-2026-OGA-UL · Expediente OGAUL020260000058 · OGA-UL · 13/05/2026 · '
        + 'Proyección de gasto · CONSIDERANDO',
    );
  });

  it('omite los campos ausentes sin dejar separadores huérfanos', () => {
    const cab = construirCabecera({ titulo: 'PROVEIDO N° 5', numeroExpediente: null, dependencia: null });
    expect(cab).toBe('PROVEIDO N° 5');
    expect(cab).not.toMatch(/·\s*·/);
  });

  it('el número de expediente se antepone con la etiqueta "Expediente"', () => {
    const cab = construirCabecera({ numeroExpediente: 'OGAUL020260000058' });
    expect(cab).toBe('Expediente OGAUL020260000058');
  });
});
