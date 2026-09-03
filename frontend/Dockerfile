# Dev-only: sirve con el dev server de Vite (HMR) dentro del contenedor, tal como quedó
# definido en docs/PLAN.md (FRONTEND_PORT). Para producción se cambiaría a un build estático
# servido por nginx en una segunda etapa — no necesario todavía para este MVP interno.
FROM node:20-alpine
WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

RUN addgroup -S appgroup && adduser -S appuser -G appgroup && chown -R appuser:appgroup /app
USER appuser

EXPOSE 5177

CMD ["npm", "run", "dev", "--", "--host"]
