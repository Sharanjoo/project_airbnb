# Build context is the repo root (see docker-compose.yml).
FROM node:22-alpine
WORKDIR /app
COPY contracts ./contracts
COPY packages/common ./packages/common
COPY services/gateway ./services/gateway
# Minimal workspace root containing only what this service needs
RUN echo '{"private":true,"workspaces":["packages/common","services/gateway"]}' > package.json \
 && npm install --omit=dev --no-audit --no-fund
WORKDIR /app/services/gateway
ENV SERVICE_NAME=gateway NODE_ENV=production
EXPOSE 8080
CMD ["node", "src/index.js"]
