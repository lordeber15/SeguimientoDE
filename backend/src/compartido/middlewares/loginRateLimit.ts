import rateLimit from 'express-rate-limit';

/**
 * Límite por IP en la ruta de login.
 *
 * Es la primera de dos barreras y cubre lo que el bloqueo por usuario no puede: probar una
 * contraseña común contra muchos usuarios distintos (password spraying) nunca acumula fallos
 * suficientes en ninguna cuenta concreta. La segunda barrera —el bloqueo por usuario— vive en
 * `authService` y usa nuestra BD.
 */
export const loginRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Demasiados intentos desde esta dirección. Espere un minuto.' },
});
