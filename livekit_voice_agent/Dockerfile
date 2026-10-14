FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Pre-download Silero VAD weights at build time so container startup is instant
RUN python -c "from livekit.plugins import silero; silero.VAD.load()"

EXPOSE 8000

CMD ["python", "-m", "app.agent", "start"]
