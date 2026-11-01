# Build context is the repo root (see docker-compose.yml).
FROM node:22-alpine
WORKDIR /app
COPY contracts ./contracts
COPY packages/common ./packages/common
COPY services/messaging-service ./services/messaging-service
# Minimal workspace root containing only what this service needs
RUN echo '{"private":true,"workspaces":["packages/common","services/messaging-service"]}' > package.json \
 && npm install --omit=dev --no-audit --no-fund
WORKDIR /app/services/messaging-service
ENV SERVICE_NAME=messaging-service NODE_ENV=production
EXPOSE 8004
CMD ["node", "src/index.js"]
