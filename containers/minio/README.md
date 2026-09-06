# MinIO — Raw Payload Store

The third tier of the Poste Restante archive spine (SPEC §3.1 / §3.2):
1. **Postgres 15** — letters, addresses, correspondences, plural-time frames, FTS
2. **Qdrant** — semantic vector embeddings
3. **MinIO** — raw binary payloads (audio letters, rehearsal recordings, attachments)

## Ports (21000 range per AGENTS.md)
- `21018`: S3 API (`http://app-minio:9000` internally on `backend_net`)
- `21019`: Web Console

## Integration with Poste Restante
The house container connects via compose service DNS on `backend_net`:
```env
MINIO_ENDPOINT=http://app-minio:9000
MINIO_BUCKET=letters
MINIO_ACCESS_KEY=poste_minio
MINIO_SECRET_KEY=<secret>
```
