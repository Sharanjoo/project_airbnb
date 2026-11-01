# Build context is the repo root (see docker-compose.yml).
FROM node:22-alpine
WORKDIR /app
COPY contracts ./contracts
COPY packages/common ./packages/common
COPY services/analytics-service ./services/analytics-service
# Minimal workspace root containing only what this service needs
RUN echo '{"private":true,"workspaces":["packages/common","services/analytics-service"]}' > package.json \
 && npm install --omit=dev --no-audit --no-fund
WORKDIR /app/services/analytics-service
ENV SERVICE_NAME=analytics-service NODE_ENV=production
EXPOSE 8006
CMD ["node", "src/index.js"]
