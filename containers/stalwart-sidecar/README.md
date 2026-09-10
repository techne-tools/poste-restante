# Poste Restante — the mailbox sidecar package (containers/stalwart-sidecar/)

The read-side mirror for the house: a Stalwart IMAP server pinned to the
exact version (v0.16.20) the house's read-side (imapflow adapter + sync
drive) is proven against on the dev Mac. Provisioned residents' mailboxes
land here as real IMAP mail.

## What it is

- ONE container (`stalwart-sidecar:local`) on the Docker homelab host.
- The house reaches it by compose DNS (`imap://…@mailbox-sidecar:11430/`)
  over `backend_net` — the host-published port (21032) is for operator /
  Spark checks only, and per-resident credentials never cross a host
  interface.
- The store is disposable: the house re-materialises the mailbox from the
  archive (a derived view — wipe it and re-sync yields the same mail).

## Ports / networks / volumes

| | |
|---|---|
| IMAP (host) | 21037 → 11430 (operator / Spark check; 21032 is calibre on horza) |
| IMAP (internal) | mailbox-sidecar:11430 on `backend_net` (the house's path) |
| Networks | `backend_net` (external) |
| Volumes | `sidecar-data` (RocksDb store), `sidecar-etc` (config) |

## Secrets

The sidecar stores per-account credentials in its own store — provisioned
by the operator, not by this package. The house stores the per-resident
IMAP URLs (`mailbox:add`), including the sidecar-specific credential. No
secret reaches this compose file or the host-published port.

## Lifecycle

```bash
./deploy.sh up -d --build          # build + start the sidecar (v1: no provisioning)
./deploy.sh sidecar:provision      # OPERATOR-GATED: apply the plan (recovery mode)
./deploy.sh logs -f                # passthrough
./deploy.sh down                   # passthrough (volumes persist)
```

### sidecar:provision (operator-gated, requires the dev Mac)

The image carries only the server binary — provisioning uses the
`stalwart-cli` from the dev Mac against a temporarily-published recovery
port, exactly like the dev sidecar's bootstrap:

1. Start the sidecar (normal mode) — the entrypoint writes the minimal
   RocksDb config.
2. `./deploy.sh sidecar:provision` on the host:
   - publishes recovery port 18080 temporarily,
   - prints the one-time admin credential from the server log,
   - the operator runs `STALWART_URL=… stalwart-cli apply --user admin
     --password … --file plan.ndjson` from the dev Mac,
   - the recovery listener is torn down.
3. Provision residents with `npm run mailbox:add` (house side) using the
   same per-account credentials from the plan.

Until the plan is applied, the container runs but has no domain, no
listener, no accounts — the house's mailbox_accounts rows have nothing to
sync against (fail closed, exactly like the house itself).

## Pinning

- Server: `v0.16.20` (`ARG STALWART_VERSION`) — the version the read-side
  is proven against (the upstream Docker image is v0.11.8, too old).
- Platform: `x86_64-unknown-linux-musl` — the homelab host is x86_64; the
  musl build runs on alpine:3.20 without glibc.

## Deliberately NOT here

- No SMTP listeners (the house has its own door + outbound seam).
- No admin UI (the house reuses the house — the operator's CLI is
  `stalwart-cli` from the dev Mac).
- No external sync (movement C stays out of scope).
