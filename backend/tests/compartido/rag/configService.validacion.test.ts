/** Validación de las claves editables desde el panel (docs/PLAN-RAG-AVANZADO.md, Fase 4). */
jest.mock('../../../src/compartido/config/appDatabase', () => ({ appSequelize: {} }));

import { validarValorConfig } from '../../../src/compartido/rag/configService';

describe('validarValorConfig', () => {
  it('chat.sinonimos: acepta un mapa término → lista de textos', () => {
    expect(validarValorConfig('chat.sinonimos', '{"alquiler":["arrendamiento"],"in house":["inhouse"]}')).toBeNull();
    expect(validarValorConfig('chat.sinonimos', '{}')).toBeNull();
  });

  it('chat.sinonimos: rechaza JSON roto, listas que no son de textos y claves o textos vacíos', () => {
    expect(validarValorConfig('chat.sinonimos', '{"alquiler":["arrendamiento"],}')).toMatch(/JSON válido/);
    expect(validarValorConfig('chat.sinonimos', '["alquiler"]')).not.toBeNull();
    expect(validarValorConfig('chat.sinonimos', '{"alquiler":"arrendamiento"}')).not.toBeNull();
    expect(validarValorConfig('chat.sinonimos', '{"alquiler":[1]}')).not.toBeNull();
    expect(validarValorConfig('chat.sinonimos', '{" ":["x"]}')).not.toBeNull();
    expect(validarValorConfig('chat.sinonimos', '{"alquiler":[" "]}')).not.toBeNull();
  });

  it('interruptores: solo true o false', () => {
    expect(validarValorConfig('chat.hyde.activo', 'true')).toBeNull();
    expect(validarValorConfig('chat.descomposicion.activa', 'false')).toBeNull();
    expect(validarValorConfig('chat.hyde.activo', 'si')).toMatch(/true o false/);
  });

  it('el resto de claves no tiene formato propio', () => {
    expect(validarValorConfig('rag.retencion.dias', '90')).toBeNull();
  });
});

describe('validarValorConfig — juez (Fase 5)', () => {
  it('muestreo y umbral: números entre 0 y 1', () => {
    expect(validarValorConfig('chat.juez.muestreo', '0.1')).toBeNull();
    expect(validarValorConfig('chat.juez.umbral_fidelidad', '1')).toBeNull();
    expect(validarValorConfig('chat.juez.muestreo', '1.5')).toMatch(/entre 0 y 1/);
    expect(validarValorConfig('chat.juez.muestreo', '')).toMatch(/entre 0 y 1/);
    expect(validarValorConfig('chat.juez.umbral_fidelidad', 'alto')).toMatch(/entre 0 y 1/);
  });
});
