# Single container: Node builds the frontend, then FastAPI serves the API and the built files on one URL.

# ---- 1. frontend build ----
FROM node:24-slim AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- 2. backend runtime ----
FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.12 /uv /usr/local/bin/uv
# OpenCV (headless) needs glib at runtime
RUN apt-get update && apt-get install -y --no-install-recommends libglib2.0-0 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PROJECT_ENVIRONMENT=/opt/venv
COPY pyproject.toml uv.lock .python-version ./
RUN uv sync --frozen --no-dev --no-install-project
COPY backend/app backend/app
COPY --from=web /web/dist frontend/dist

# SQLite DB + uploaded PDFs + page images + signed PDFs. Mount a persistent volume here.
ENV DATA_DIR=/data PATH=/opt/venv/bin:$PATH
VOLUME /data
EXPOSE 8000
# ANTHROPIC_API_KEY must be provided at runtime (never baked into the image). PORT is set by most hosts.
CMD ["sh", "-c", "uvicorn app.api:app --app-dir backend --host 0.0.0.0 --port ${PORT:-8000}"]
