# Build context is the repo root (see docker-compose.yml).
FROM node:22-alpine
WORKDIR /app
COPY contracts ./contracts
COPY packages/common ./packages/common
COPY services/property-service ./services/property-service
# Minimal workspace root containing only what this service needs
RUN echo '{"private":true,"workspaces":["packages/common","services/property-service"]}' > package.json \
 && npm install --omit=dev --no-audit --no-fund
WORKDIR /app/services/property-service
ENV SERVICE_NAME=property-service NODE_ENV=production
EXPOSE 8002
CMD ["node", "src/index.js"]
