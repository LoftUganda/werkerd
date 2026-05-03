# WERKERD — Self-Hosted Cloudflare Workers

A production-ready, self-hosted runtime for Cloudflare Workers using the open-source [workerd](https://github.com/cloudflare/workerd) binary. Deploy any Cloudflare Workers project to your own server with `werkerd deploy` — zero config changes required.

**Server**: `18.171.244.124` (Ubuntu 24.04) | **CLI**: `werkerd deploy`

---

## Quickstart

```bash
# 1. Install the CLI
cd werkerd-cli && npm install && npm link

# 2. Deploy any Cloudflare Workers project
cd examples/hello
werkerd deploy --port 8080

# 3. Test
curl http://18.171.244.124:8080/
# Or via nginx LB: curl http://hello.localhost/
```

Works on any existing Cloudflare Workers project — just run `werkerd deploy`. It reads your `wrangler.jsonc`, bundles with esbuild, uploads, and starts the service.

---

## What This Is

- **Drop-in `wrangler deploy` replacement**: Works with existing Cloudflare Workers projects
- **100% workerd-native**: No emulation layer, no translation — real workerd
- **Hono, Vite+React, SvelteKit first-class**: Full framework support
- **Service bindings, Durable Objects, WebSockets**: All Cloudflare APIs work
- **Git-driven scaling**: Edit a config file, push, get more RPS
- **nginx reverse proxy**: ~9% overhead (vs Caddy's ~2x)

---

## Architecture

```
Internet
   │
   ▼
nginx :80  ←─── Health checks, load balancing, hostname routing
   │
   ├── hello.localhost  ──► workerd @ :8080, :8081 (scaled)
   ├── hono-app.localhost ──► workerd @ :8082
   ├── fullstack.localhost ──► workerd @ :8085 (DO + WS)
   └── vite-react.localhost ──► workerd @ :8083

Each workerd process runs in a systemd socket-activated service.
Scaling = change instance count in scale file → server auto-applies.
```

---

## Live Workers

| Worker | URL | Direct Port |
|--------|-----|-------------|
| hello | `http://hello.localhost/` | `:8080`, `:8081` (scaled) |
| hono-app | `http://hono-app.localhost/` | `:8082` |
| fullstack | `http://fullstack.localhost/diag` | `:8085` (DO + WS) |
| vite-react | `http://vite-react.localhost/api/info` | `:8083` |

---

## CLI Commands

```bash
# Deploy any Cloudflare Workers project
werkerd deploy --port 8080

# Override server
WERKERD_SERVER=root@my-server.com werkerd deploy --port 8080
```

---

## Scaling

```bash
# Show server CPU cores and scaling advice
workerd-scale info

# Set instance count (git-driven: edit file, push, server applies)
ssh root@18.171.244.124
echo 2 > /etc/workerd/workers/hello/scale
workerd-scale set hello 2

# Check status
workerd-scale list hello
```

**Scaling only improves RPS if you have more CPU cores than instances.**
- On a 2-core VM: 1 instance saturates both cores. Scaling to 2 adds overhead.
- On 4+ cores: Scaling is linear — 1 instance per core = full throughput.

**To reach 1M RPS**: ~120 cores at ~8,000 RPS/core behind nginx.

---

## Performance

| Configuration | RPS | p50 | p99 |
|---|---|---|---|
| Direct workerd | **8,957** | 13ms | 93ms |
| nginx LB (1 backend) | **8,118** | 21ms | 143ms |
| nginx LB (2 backends) | **8,327** | 20ms | 171ms |
| Hono via nginx | **2,575** | 15ms | 35ms |
| Fullstack DO via nginx | **6,846** | 26ms | 1.04s |

**nginx overhead**: ~9-11% for simple JSON workers.

---

## Project Structure

```
werkerd/
├── werkerd-cli/           # The CLI (npm install && npm link)
│   ├── bin/werkerd.js     # Entry point
│   └── lib/
│       ├── deploy.js      # Deploy pipeline
│       ├── config-reader.js  # wrangler.jsonc parser
│       └── capnp-gen.js    # Cap'n Proto config generator
├── examples/              # Example projects
│   ├── hello/             # Minimal worker
│   ├── hono-app/          # Hono framework
│   ├── vite-react/        # Vite + React SSR
│   └── fullstack/         # DO + WebSocket + env vars
├── management-scripts/    # Server-side scripts
│   ├── bootstrap.sh       # Fresh server setup
│   ├── workerd-scale      # Git-driven scaling CLI
│   ├── workerd-gen-nginx  # nginx config generator
│   ├── workerd-gen-config # Cap'n Proto config generator
│   └── post-receive       # Git push deploy hook
└── docs/                  # Full documentation
```

---

## Documentation

| Doc | Contents |
|-----|---------|
| [SKILL.md](docs/SKILL.md) | Complete guide: CLI, wrangler.jsonc schema, troubleshooting |
| [architecture.md](docs/architecture.md) | System diagrams, component layers, data flow |
| [configuration.md](docs/configuration.md) | Cap'n Proto config schema, wrangler.jsonc reference |
| [deploying.md](docs/deploying.md) | All deployment methods: CLI, git push, rollback |
| [scaling.md](docs/scaling.md) | Git-driven scaling, workerd-scale CLI, resource limits |
| [secrets.md](docs/secrets.md) | Environment variables, .env handling, security |
| [troubleshooting.md](docs/troubleshooting.md) | All known errors, diagnostics, fixes |
| [howto.md](docs/howto.md) | Recipes: Hono, Vite, DO, KV, WebSockets, SvelteKit |

---

## Key Files

- `/etc/workerd/workers/<name>/scale` — Desired instance count (1, 2, 3...)
- `/etc/workerd/workers/<name>/ports` — Active port list
- `/etc/nginx/sites-available/workerd` — Generated nginx config
- `/usr/local/bin/workerd-scale` — Scaling CLI
- `/usr/local/bin/workerd-gen-nginx` — Regenerates nginx config
