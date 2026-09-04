/**
 * `TRAMOS_FASE` es la tabla que decide dónde se dibuja la barra de progreso de un documento en
 * curso. Un error aquí no rompe ningún tipo ni ninguna consulta — se ve directamente en pantalla
 * como una barra que retrocede o que se queda a medias en un caso que en realidad terminó bien.
 * Estos tests verifican las tres invariantes de las que depende `PanelJobIngesta.tsx` sin tener
 * que renderizar nada.
 */

import { TRAMOS_FASE, type FaseConversion } from '../../src/rag/fasesConversion';

const ORDEN: FaseConversion[] = [
  'descargando',
  'deduplicando',
  'esperando_circuito',
  'en_cola_conversor',
  'convirtiendo',
  'troceando',
  'guardando',
  'listo',
];

describe('TRAMOS_FASE', () => {
  it('cada tramo es [inicio, fin] con inicio <= fin', () => {
    for (const fase of Object.keys(TRAMOS_FASE) as FaseConversion[]) {
      const [inicio, fin] = TRAMOS_FASE[fase];
      expect(inicio).toBeLessThanOrEqual(fin);
    }
  });

  it('los tramos del camino principal son contiguos y crecientes — la barra nunca retrocede', () => {
    for (let i = 1; i < ORDEN.length; i++) {
      const [, finAnterior] = TRAMOS_FASE[ORDEN[i - 1]];
      const [inicioActual] = TRAMOS_FASE[ORDEN[i]];
      expect(inicioActual).toBeGreaterThanOrEqual(finAnterior);
    }
  });

  it('"generando" ocupa exactamente el mismo tramo que "convirtiendo": son alternativas del mismo paso', () => {
    expect(TRAMOS_FASE.generando).toEqual(TRAMOS_FASE.convirtiendo);
  });

  it('"listo" es 100: todo camino terminal (dedup, sin archivo, error) cierra la barra al completo', () => {
    expect(TRAMOS_FASE.listo).toEqual([100, 100]);
  });

  it('las fases de espera no avanzan nada: se aparcan al inicio del tramo de conversión', () => {
    expect(TRAMOS_FASE.esperando_circuito).toEqual([15, 15]);
    expect(TRAMOS_FASE.en_cola_conversor).toEqual([15, 15]);
    expect(TRAMOS_FASE.esperando_circuito[0]).toBe(TRAMOS_FASE.convirtiendo[0]);
  });

  it('el primer tramo empieza en 0', () => {
    expect(TRAMOS_FASE.descargando[0]).toBe(0);
  });
});
