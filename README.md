# WERKERD

A self-hosted Cloudflare Workers runtime built on [workerd](https://github.com/cloudflare/workerd) — the open-source Workers runtime from Cloudflare.

**Status**: Operational on Ubuntu 24.04 at `18.171.244.124`

## Features

- **100% workerd-native** — no proxy, no emulation, no translation layer
- **Service bindings** — in-process RPC between workers (zero network overhead)
- **Durable Objects** — stateful serverless objects with SQLite storage
- **KV namespace** — key-value storage
- **R2 buckets** — object storage bindings
- **WebSockets** — real-time bidirectional communication
- **ES modules & Service Worker** — both module formats supported
- **Environment variables** — .env file sourcing with `fromEnvironment` bindings
- **Zero-downtime deploys** — git push triggers config regeneration + rolling restart
- **Socket activation** — systemd lazily spawns workers on first request
- **Load balancing** — Caddy reverse proxy with health checks
- **Scaling** — per-worker instance scaling across multiple ports
- **SvelteKit** — deploy SvelteKit apps with SSR
- **Static assets** — serve HTML/CSS/JS from workers

## Quickstart

```bash
# Server setup (Ubuntu 22.04+)
ssh ubuntu@your-server
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g workerd

# Install Caddy
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy

# Install management scripts
sudo cp management-scripts/* /usr/local/bin/
sudo chmod +x /usr/local/bin/workerd-*
sudo cp management-scripts/workerd@.service /etc/systemd/system/
sudo systemctl daemon-reload

# Deploy your first worker
sudo mkdir -p /etc/workerd/workers/hello
echo '{"name":"hello","compatibilityDate":"2024-09-23","entrypoint":"worker.js"}' | sudo tee /etc/workerd/workers/hello/manifest.json
# Write your worker.js to /etc/workerd/workers/hello/worker.js
sudo /usr/local/bin/workerd-gen-config hello 8080
sudo /usr/local/bin/workerd-scale up hello 8080

# Test
curl http://localhost:8080/
```

## Architecture

```
Internet → Caddy (:80) → systemd socket → workerd → Worker code
                ↓           activation         ↓
           Health checks   Per-instance    Service bindings
           Load balancing    sockets       Durable Objects
```

See [docs/architecture.md](docs/architecture.md) for full diagrams.

## Documentation

| Document | Content |
|----------|---------|
| [SKILL.md](docs/SKILL.md) | Complete deployment guide & skill reference |
| [configuration.md](docs/configuration.md) | manifest.json schema, Cap'n Proto config, scripts |
| [deploying.md](docs/deploying.md) | Git push, manual, and SCP deployment methods |
| [scaling.md](docs/scaling.md) | Scale up/down, rollout strategy, resource limits |
| [secrets.md](docs/secrets.md) | Environment variables, .env files, best practices |
| [architecture.md](docs/architecture.md) | System diagrams, data flow, directory layout |
| [troubleshooting.md](docs/troubleshooting.md) | Common errors, logs, debugging |
| [howto.md](docs/howto.md) | Recipes for every feature (ESM, DO, KV, WS, SvelteKit) |

## Example Workers

| Worker | Features |
|--------|----------|
| [hello](example-worker/worker.js) | Basic fetch handler, healthz, JSON response |
| [api + auth](example-worker/api-worker.js) | Service bindings, env vars, ES modules, multi-worker group |
| [fullstack](example-worker/fullstack-worker.js) | Durable Objects, KV, WebSockets, HTML dashboard |
| [sveltekit](example-worker/sveltekit-worker.js) | SvelteKit-style SSR on workerd |

## Management Scripts

| Script | Purpose |
|--------|---------|
| `workerd-gen-config` | Generate Cap'n Proto config from manifest.json |
| `workerd-start` | systemd ExecStart wrapper — extracts port, runs workerd |
| `workerd-scale` | Scale workers up/down across ports |
| `workerd-gen-caddyfile` | Generate Caddy reverse-proxy config |
| `workerd-deploy` | Manual deploy (alternative to git push) |

## Repository Structure

```
werkerd/
├── README.md
├── docs/
│   ├── SKILL.md
│   ├── architecture.md
│   ├── configuration.md
│   ├── deploying.md
│   ├── howto.md
│   ├── scaling.md
│   ├── secrets.md
│   └── troubleshooting.md
├── example-worker/
│   ├── worker.js              # Basic hello worker
│   ├── manifest.json          # Example manifest
│   ├── wrangler.jsonc         # Wrangler compat config
│   ├── api-worker.js          # Service bindings + env vars
│   ├── auth-worker.js         # Auth worker (group member)
│   ├── api-manifest.json      # Multi-worker manifest
│   ├── fullstack-worker.js    # DO + KV + WebSockets
│   ├── fullstack-manifest.json
│   ├── sveltekit-worker.js    # SvelteKit-style SSR
│   └── sveltekit-manifest.json
├── management-scripts/
│   ├── bootstrap.sh           # Full server bootstrap
│   ├── workerd-gen-config     # Config generator (Node.js)
│   ├── workerd-start          # Systemd exec wrapper
│   ├── workerd-scale          # Scale up/down/list
│   ├── workerd-gen-caddyfile  # Caddyfile generator
│   ├── workerd@.service       # Systemd template unit
│   ├── post-receive           # Git deploy hook
│   └── deploy.sh              # Wrangler-based deploy
└── workerd-platform-handoff.md  # Original platform spec
```

## Server Endpoints (Live)

```
http://18.171.244.124/           Hello worker (JSON)
http://18.171.244.124/healthz    Health check → "ok"
http://18.171.244.124:8090/      API worker (auth-protected)
http://18.171.244.124:8090/diag  Env vars + binding diagnostics
http://18.171.244.124:9000/      Fullstack demo (DO + KV + WS)
```

## Related

- [workerd on GitHub](https://github.com/cloudflare/workerd)
- [Cloudflare Workers docs](https://developers.cloudflare.com/workers/)
- [Caddy docs](https://caddyserver.com/docs/)
- [systemd socket activation](https://www.freedesktop.org/software/systemd/man/latest/systemd.socket.html)

## License

MIT
