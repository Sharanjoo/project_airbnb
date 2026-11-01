# Build context is the repo root (see docker-compose.yml).
FROM python:3.12-slim
WORKDIR /app
COPY services/ai-service/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY contracts /app/contracts
COPY services/ai-service /app/ai-service
WORKDIR /app/ai-service
ENV CONTRACTS_DIR=/app/contracts PYTHONUNBUFFERED=1
EXPOSE 8007
# The same image runs the API (default) or one agent:
#   command: ["python", "-m", "agents", "matching"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8007"]
