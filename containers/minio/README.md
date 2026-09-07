# MinIO — Raw Payload Store

The third tier of the Poste Restante archive spine (SPEC §3.1 / §3.2):
1. **Postgres 15** — letters, addresses, correspondences, plural-time frames, FTS
2. **Qdrant** — semantic vector embeddings
3. **MinIO** — raw binary payloads (audio letters, rehearsal recordings, attachments)

## Ports (21000 range per AGENTS.md)
- `21035`: S3 API (`http://app-minio:9000` internally on `backend_net`) — probed
  free 2026-09-07; the doc'd 21018 is immich on horza. Configure via
  `MINIO_PORT_API` in `.env.public`.
- Web console: off for alpha (`MINIO_BROWSER=off`). The house's S3 API is the
  test surface; re-enable by setting `MINIO_BROWSER=on` and adding a
  `--console-address ":9001"` command + port publish when the console is
  actually needed.

## Integration with Poste Restante
The house container connects via compose service DNS on `backend_net`:
```env
MINIO_ENDPOINT=http://app-minio:9000
MINIO_BUCKET=letters
MINIO_ACCESS_KEY=poste_minio
MINIO_SECRET_KEY=<secret>
```
`MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY` are the **house's** credentials for the
store — the house is a separate caller from the MinIO root user
(`MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` in MinIO's own `.env.enc`). For the
alpha they may be the same user; the separation is already reflected in the
house compose (keys from the house's own `.env.enc`).
