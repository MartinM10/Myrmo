FROM python:3.7.17-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends gnupg curl ca-certificates \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update && apt-get install -y --no-install-recommends postgresql-16 \
 && rm -rf /var/lib/apt/lists/*
# An old driver, from before pg8000 learned SCRAM-SHA-256: it cannot log in to a PostgreSQL 14+ server.
RUN pip install --no-cache-dir pg8000==1.12.5
COPY start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh
WORKDIR /work
COPY files/ /work/
CMD ["/usr/local/bin/start.sh"]
