# ---- Builder: instala TODAS las dependencias y compila TypeScript ----
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Runtime: solo dependencias de producción + el build compilado ----
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
# Las migraciones son .sql: no pasan por tsc, hay que copiarlas aparte. La ruta relativa que usa
# migraciones.ts (`../../migrations` desde dist/config/) resuelve a /app/migrations.
COPY migrations ./migrations

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 3012

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3012) + '/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "dist/server.js"]
