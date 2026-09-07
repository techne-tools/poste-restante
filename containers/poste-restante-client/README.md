# containers/poste-restante-client — the reference client as a container

For alpha testers: serves the built React reference client and proxies
`/v1` to the house on `backend_net`. The house itself stays headless
(invariant 1) — this is *a* client the operator composed (invariant 2), not
the house's UI.

## The tailnet face (host-serve — the sidecar collapse)

Alpha testers reach the client on the tailnet through the **host's single
Tailscale node** (the fleet model since the sidecar collapse, 2026-08-23)
— `horza` proxies `https://poste-restante-client.mermaid-darter.ts.net:21034`
→ `127.0.0.1:21034`, i.e. into this container:

```bash
# on horza, as root — register the client's slot in the host serve map
tailscale serve --bg --https=21034 --service svc:poste-restante-client "http://127.0.0.1:21034"
```

- **Tailnet:** `https://poste-restante-client.mermaid-darter.ts.net:21034`
  → the static face; `/v1` proxies on to the house over `backend_net`.
  Testers never touch the protocol directly.
- **No sidecar container, no `TS_AUTHKEY`** — the collapse took 30
  per-stack sidecars to zero and the client does not resurrect one. Its
  own tailnet identity is just a host-serve entry (the client and the
  protocol node `poste-restante` are distinct serve names on the one host
  node).
- No credentials live in this container — the browser holds the house auth
  and sends it through the proxy untouched.

## Files

- `Dockerfile` — two stages: build the client bundle (tsc + vite), then
  serve it from `nginx:1.27-alpine` with the proxy config.
- `nginx.conf` — static files + `location /v1/ → http://house:8787/v1/`.
  `client_max_body_size 30m` mirrors the house's upload limit — nginx's
  1 MB default would silently 413 enclosure uploads.
- `compose.yml` — the client service on `backend_net`, host port
  `$CLIENT_PORT` (default 21034, probed free 2026-09-07; the house uses
  21016, the door 21036).
- `.env.public` — non-secret knob (`CLIENT_PORT`).
- `deploy.sh` — thin passthrough to compose (no secrets in this package,
  and tailnet access is host-serve — see above).

## Deploy (from the host)

```bash
cd containers/poste-restante-client
./deploy.sh up -d --build          # build the bundle + start
curl -s http://127.0.0.1:21034/          # → index.html
curl -s http://127.0.0.1:21034/v1/health # → {"status":"awake"} (via the house)
```

## Why it exists

- The house image ships only the protocol (no UI — invariant 1).
- Alpha testers are not headless-protocol people; the reference client is
  the composed space.
- Serving it from its own container keeps the house image pure and the
  client independently updateable (rebuild this package only).

## Ops notes

- Auth: the browser holds the credential (Basic in localStorage) and sends
  it on every `/v1` request; nginx proxies it through untouched. The nginx
  surface adds no visibility of its own.
- Same `backend_net` as the house; reach it by compose DNS `house:8787`.
- watchtower-excluded (locally-built image, same convention as the house).
