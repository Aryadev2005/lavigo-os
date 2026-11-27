# Backup sidecar (NFR-2): daily pg_dump → S3-compatible object storage, keeping 14 days.
# pg_dump comes from the same major version as the server (postgres:16).
FROM postgres:16-alpine
RUN apk add --no-cache aws-cli tzdata
COPY backup.sh /usr/local/bin/backup.sh
RUN chmod 0755 /usr/local/bin/backup.sh
USER postgres
ENTRYPOINT ["/usr/local/bin/backup.sh"]
