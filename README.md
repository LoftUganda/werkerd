# WERKERD

A self-hosted Cloudflare Workers runtime built on [workerd](https://github.com/cloudflare/workerd) — the open-source Workers runtime from Cloudflare.

> **Status**: Operational on Ubuntu 24.04 at `18.171.244.124`  
> **CLI**: `werkerd deploy` — works like `wrangler deploy` on any Cloudflare Workers project

## Features

- **CLI-first**: `werkerd deploy` reads `wrangler.jsonc`, bundles with esbuild, deploys to your server
- **Hono first-class**: Full Hono framework support — routing, JSON, HTML, middleware
- **Vite + React SSR first-class**: Build your Vite app and deploy to workerd
- **100% workerd-native** — no proxy, no emulation, no translation layer
- **Service bindings** — in-process RPC between workers (`env.NAME.fetch()`)
- **Durable Objects** — stateful objects with in-memory storage (Counter, ChatRoom)
- **WebSockets** — real-time bidirectional communication via `WebSocketPair`
- **ES modules** — `export default { fetch }` format, auto-detected
- **Environment variables** — `.env` file + text bindings for config
- **Zero-downtime deploys** — rolling restart across instances
- **Socket activation** — systemd lazily spawns workers on first request
- **Load balancing** — Caddy reverse proxy with `/healthz` checks and connection pooling
- **Scaling** — per-worker instance scaling across multiple ports; ~4,550 RPS/core
- **Observability** — Caddy admin API on `:2019/metrics` for monitoring

## Quickstart

```bash
# 1. Install the CLI
cd werkerd-cli && npm install && npm link

# 2. Deploy any project — zero config editing
cd examples/hono-app
npm install
werkerd deploy --port 8082

# 3. Verify
curl http://18.171.244.124:8082/
```

Works on any Cloudflare Workers project — just run `werkerd deploy`.

## Examples

All examples are standard npm projects. Each has `wrangler.jsonc` + `package.json` + `src/index.js`:

| Project | Directory | Deploy Command | Features |
|---------|-----------|---------------|----------|
| **Hello** | `examples/hello/` | `werkerd deploy --port 8084` | Minimal worker, text bindings |
| **Hono** | `examples/hono-app/` | `werkerd deploy --port 8082` | Full Hono framework, routing, JSON, HTML |
| **Vite React SSR** | `examples/vite-react/` | `werkerd deploy --port 8083` | Vite build, React SSR on workerd |
| **Fullstack** | `examples/fullstack/` | `werkerd deploy --port 8085` | Durable Objects, WebSockets, env vars |
| **API + Auth** | `example-worker/` | `workerd-scale up api 8090` | Service bindings, env vars, multi-worker |

All examples are deployed and live on the server.

## Performance

| Configuration | RPS | p50 Latency | p99 Latency |
|---|---|---|---|
| Direct workerd (1 instance, localhost) | **8,873** | 5.5ms | — |
| Caddy LB :80 → 5 instances | **4,425** | 43ms | 114ms |
| Caddy LB (unoptimized baseline) | 2,893 | 52ms | 757ms |
| Hono app (1 instance, localhost) | **926** | 65ms | 476ms |
| Fullstack (DO counter) | **3,508** | 1.5ms | 269ms |
| External (London ← US) | ~340 | 250ms | 878ms |

**Scaling**: Each workerd instance delivers ~4,550 RPS per core. Instances scale linearly — 2 instances = 2x throughput. Caddy LB adds ~2x overhead (expected for any L7 proxy). To reach 1M RPS: ~220 cores with direct workerd, ~440 cores behind Caddy.

**Caddy optimizations applied** (connection pooling and keepalive from `workerd-gen-caddyfile`):
- `max_conns_per_host200` — prevents upstream connection exhaustion
- `keepalive30s` — reuses TCP connections (biggest win — eliminates per-request handshake)
- `keepalive_idle_conns100` — pool of warm connections ready for reuse
- `log level WARN` — reduces I/O pressure from access logging
- Admin API on `:2019` for `curl localhost:2019/metrics` monitoring

## Live Endpoints

| Port | Worker | Type | Test |
|------|--------|------|------|
| `:80` | hello | Caddy LB | `curl 18.171.244.124/` |
| `:8080` | hello | Service worker | `curl 18.171.244.124:8080/` |
| `:8081` | hello | Service worker (scale) | `curl 18.171.244.124:8081/` |
| `:8082` | hono-app | Hono framework | `curl 18.171.244.124:8082/` |
| `:8083` | vite-react | Vite React SSR | `curl 18.171.244.124:8083/` |
| `:8084` | hello (cli) | CLI deploy test | `curl 18.171.244.124:8084/` |
| `:8085` | fullstack | DO + WS | `curl 18.171.244.124:8085/diag` |
| `:8090` | api + auth | Service bindings | `curl 18.171.244.124:8090/diag` |

## Documentation

| Document | Content |
|----------|---------|
| [SKILL.md](docs/SKILL.md) | Complete guide: CLI, examples, wrangler.jsonc, troubleshooting |
| [configuration.md](docs/configuration.md) | Cap'n Proto config, manifest format, script reference |
| [deploying.md](docs/deploying.md) | Deployment methods (CLI, git push, manual, SCP) |
| [scaling.md](docs/scaling.md) | Scale up/down, rollout strategy |
| [secrets.md](docs/secrets.md) | Environment variables, .env files |
| [architecture.md](docs/architecture.md) | System diagrams, data flow |
| [troubleshooting.md](docs/troubleshooting.md) | Common errors, logs, debugging |
| [howto.md](docs/howto.md) | Recipes: Hono, Vite, DO, KV, WebSockets, SvelteKit |

## CLI Commands

```bash
werkerd deploy [--port <port>]    # Deploy current project
werkerd whoami                    # Show server + deployed workers
```

The server defaults to `root@18.171.244.124`. Override with `export WERKERD_SERVER=root@my-host`.

## Repository Structure

```
werkerd/
├── README.md
├── werkerd-cli/              # The werkerd CLI (npm install && npm link)
│   ├── bin/werkerd.js
│   └── lib/
│       ├── deploy.js         # Deploy pipeline
│       ├── config-reader.js  # wrangler.jsonc parser
│       └── capnp-gen.js      # Cap'n Proto config generator
├── examples/                 # Example projects (standard npm projects)
│   ├── hello/                # Minimal worker
│   ├── hono-app/             # Hono framework
│   ├── vite-react/           # Vite React SSR
│   └── fullstack/            # DO + WebSocket + env vars
├── example-worker/           # Legacy examples (manifest.json format)
├── management-scripts/       # Server-side scripts
│   ├── bootstrap.sh          # Full server bootstrap
│   ├── workerd-gen-config    # Config generator (Node.js)
│   ├── workerd-start         # Systemd exec wrapper
│   ├── workerd-scale         # Scale up/down/list
│   ├── workerd-gen-caddyfile # Caddyfile generator
│   └── workerd@.service      # Systemd template unit
└── docs/                     # Full documentation
    ├── SKILL.md
    ├── architecture.md
    ├── configuration.md
    ├── deploying.md
    ├── howto.md
    ├── scaling.md
    ├── secrets.md
    └── troubleshooting.md
```

## Architecture

```
Internet → Caddy (:80) → systemd socket → workerd → Worker code
                ↓           activation         ↓
           Health checks   Per-instance    Service bindings
           Load balancing    sockets       Durable Objects
```

See [docs/architecture.md](docs/architecture.md) for full diagrams.

## Related

- [workerd on GitHub](https://github.com/cloudflare/workerd)
- [Cloudflare Workers docs](https://developers.cloudflare.com/workers/)
- [Hono](https://hono.dev/)
- [Caddy docs](https://caddyserver.com/docs/)
- [systemd socket activation](https://www.freedesktop.org/software/systemd/man/latest/systemd.socket.html)

## License

MIT
