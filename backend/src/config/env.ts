import path from 'path';
import dotenv from 'dotenv';

// El .env vive en la raíz del proyecto (compartido con frontend y docker-compose), no dentro
// de backend/. Este módulo debe ser el PRIMER import de server.ts: en Node/CommonJS, cada
// import ejecuta su require() en el orden en que aparece, así que cargar el .env aquí primero
// garantiza que config/database.ts (que lee process.env al importarse) ya vea las variables.
// En Docker las variables llegan inyectadas vía env_file, así que si este archivo no existe
// (dentro del contenedor) dotenv no encuentra nada y sigue sin error.
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
