# Loopback central service (FastAPI + SQLite/FTS5).
# The container is the deployment artifact (design §8); where it runs is infra's concern.
FROM python:3.13-slim

WORKDIR /app

# Install deps first for layer caching.
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# App code, the wire-contract schema, and the operator CLI utilities
# (read-only listing + admin token issuance).
COPY app /app/app
COPY feedback-record.schema.json /app/feedback-record.schema.json
COPY show_latest_feedback.py /app/show_latest_feedback.py
COPY issue_token.py /app/issue_token.py

# SQLite DB lives on a writable path inside the container (mount a volume in prod).
# Mint per-user tokens against this same DB, e.g.:
#   docker exec <container> python3 issue_token.py --email you@example.com --admin
ENV DB_PATH=/data/loopback.db
RUN mkdir -p /data

EXPOSE 8080

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
