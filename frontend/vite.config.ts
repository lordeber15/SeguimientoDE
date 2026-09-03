import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// El .env vive en la raíz del proyecto (compartido con backend y docker-compose),
// un nivel arriba de frontend/ — por eso envDir apunta a '../'.
export default defineConfig(({ mode }) => {
  const rootEnv = loadEnv(mode, '..', '');
  const port = Number(rootEnv.FRONTEND_PORT ?? 5177);

  return {
    plugins: [react()],
    envDir: '../',
    server: {
      host: true, // necesario para acceder desde la LAN y desde dentro de Docker
      port: 5177,
      //allowedHosts: ['serv5.ue118.gob.pe'],
      strictPort: true,
    },
  };
});
