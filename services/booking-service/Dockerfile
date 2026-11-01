# Build context is the repo root (see docker-compose.yml).
FROM node:22-alpine
WORKDIR /app
COPY contracts ./contracts
COPY packages/common ./packages/common
COPY services/booking-service ./services/booking-service
# Minimal workspace root containing only what this service needs
RUN echo '{"private":true,"workspaces":["packages/common","services/booking-service"]}' > package.json \
 && npm install --omit=dev --no-audit --no-fund
WORKDIR /app/services/booking-service
ENV SERVICE_NAME=booking-service NODE_ENV=production
EXPOSE 8003
CMD ["node", "src/index.js"]
