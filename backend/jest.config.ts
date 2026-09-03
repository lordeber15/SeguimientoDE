import type { Config } from 'jest';
import { createDefaultPreset } from 'ts-jest';

const config: Config = {
  ...createDefaultPreset(),
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  clearMocks: true,
};

export default config;
