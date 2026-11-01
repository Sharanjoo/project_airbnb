# Build context is the repo root (see docker-compose.yml).
FROM node:22-alpine
WORKDIR /app
COPY contracts ./contracts
COPY packages/common ./packages/common
COPY services/review-service ./services/review-service
# Minimal workspace root containing only what this service needs
RUN echo '{"private":true,"workspaces":["packages/common","services/review-service"]}' > package.json \
 && npm install --omit=dev --no-audit --no-fund
WORKDIR /app/services/review-service
ENV SERVICE_NAME=review-service NODE_ENV=production
EXPOSE 8005
CMD ["node", "src/index.js"]
