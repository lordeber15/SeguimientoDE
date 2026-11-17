import type { Config } from 'jest';
import { createDefaultPreset } from 'ts-jest';

const config: Config = {
  ...createDefaultPreset(),
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  clearMocks: true,
  // ts-jest sin `isolatedModules` tipa el programa COMPLETO (todo `src/**/*.ts`, por tsconfig)
  // la primera vez que un worker compila cualquier archivo — no solo el que ese test importa. El
  // proyecto creció bastante con el módulo STD, y esa primera compilación en frío empezó a superar
  // los 5000 ms por defecto en el primer test de un worker (ej. tests/app.test.ts), sin que el
  // propio test tenga nada lento. 15 s da margen de sobra sin esconder un test realmente colgado.
  testTimeout: 15_000,
  // Este proyecto corre normalmente con Docker (docker-compose up) en la misma máquina donde
  // también se ejecutan los tests — db-app, backend y frontend consumen CPU de fondo. Con el
  // número de workers por defecto (núcleos - 1), ese reparto satura la máquina y hace más lenta
  // justo la compilación en frío de arriba, al punto de que tests/app.test.ts (bind de un socket
  // real vía supertest) llega a fallar por timeout — verificado: con '50%' la suite entera corre
  // limpia y más rápido que con el valor por defecto bajo esa carga.
  maxWorkers: '50%',
};

export default config;
