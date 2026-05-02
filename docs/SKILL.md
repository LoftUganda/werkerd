# werkerd — Skill

## Overview

`werkerd` is a self-hosted Cloudflare Workers runtime using the open-source `workerd` binary. It provides a CLI (`werkerd deploy`) that works like `wrangler deploy` — run it in any Cloudflare Workers project directory and it deploys to your own server. No Cloudflare account needed.

**Server**: `root@18.171.244.124` (Ubuntu 24.04)

## Quickstart

```bash
# 1. Install the CLI
cd werkerd-cli && npm install && npm link

# 2. Deploy any Cloudflare Workers project
cd ~/my-worker-project
werkerd deploy --port 8080

# That's it. Zero config editing.
```

The CLI reads `wrangler.jsonc` (or `wrangler.toml`) from your project, bundles with esbuild if needed, generates the Cap'n Proto config, uploads everything, and starts a systemd socket-activated service on the target port.

## When to Use This Skill

Load this skill when:
- Deploying a worker to `root@18.171.244.124`
- Setting up service bindings, Durable Objects, KV, or WebSockets
- Scaling a worker up/down across ports
- Troubleshooting systemd, Caddy, or workerd config issues
- Adding environment variables or secrets to workers
- Setting up a new server from scratch

## Architecture

```
┌──────────────────────────────────────────────────┐
│                  Internet                         │
└─────────────────┬────────────────────────────────┘
                  │ :80
                  ▼
┌──────────────────────────────────────────────────┐
│  Caddy (reverse proxy)                            │
│  /etc/caddy/Caddyfile                             │
└─────────────┬────────────┬────────────────────────┘
              │            │
     localhost:8080  localhost:8081  (up to N ports)
              │            │
              ▼            ▼
┌──────────────────────────────────────────────────┐
│  systemd socket activation                       │
│  workerd-<name>-<port>.socket → workerd@<name>:<port>
└──────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────┐
│  workerd process (per instance)                   │
│  /usr/bin/workerd serve config.<port>.capnp       │
│  --socket-fd http=3                               │
└──────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────┐
│  /etc/workerd/workers/<name>/                     │
│    index.js              ← uploaded by CLI        │
│    config.<port>.capnp   ← generated per port     │
│    .env                  ← environment variables  │
│    ports                 ← active port list        │
└──────────────────────────────────────────────────┘
```

## Project Format

Any project with `wrangler.jsonc` works. Standard Cloudflare Workers project structure:

```
my-project/
├── wrangler.jsonc       ← read by werkerd deploy
├── package.json
├── src/
│   └── index.js         ← entrypoint
└── .env                 ← optional, copied to server for secrets
```

### wrangler.jsonc

The CLI reads standard Cloudflare `wrangler.jsonc` fields:

```jsonc
{
  "name": "my-worker",
  "main": "src/index.js",
  "compatibility_date": "2024-09-23",

  // Text bindings (available as env.VAR_NAME)
  "vars": {
    "GREETING": "Hello!",
    "APP_ENV": "production"
  },

  // KV namespaces
  "kv_namespaces": [
    { "binding": "STORE", "id": "my-store" }
  ],

  // R2 buckets
  "r2_buckets": [
    { "binding": "ASSETS", "bucket_name": "my-bucket" }
  ],

  // D1 databases
  "d1_databases": [
    { "binding": "DB", "database_id": "my-db" }
  ],

  // Durable Objects
  "durable_objects": {
    "bindings": [
      { "name": "COUNTER", "class_name": "Counter" },
      { "name": "ROOM",    "class_name": "ChatRoom" }
    ]
  },

  // Service bindings (call other workers)
  "services": [
    { "binding": "AUTH", "service": "auth-worker" }
  ],

  // Queues
  "queues": {
    "producers": [
      { "binding": "TASKS", "queue": "task-queue" }
    ]
  }
}
```

## CLI Commands

### werkerd deploy

```bash
werkerd deploy [--port <port>]
```

What it does:
1. Reads `wrangler.jsonc` from current directory2. Auto-bundles with esbuild if the project has npm dependencies3. Generates Cap'n Proto config for workerd4. Copies `.env` from project (if exists) for secrets5. Uploads everything to the server via SCP6. Creates systemd socket unit and starts the service7. Health-checks the endpoint

```bash
# Deploy to default port (8080)
werkerd deploy

# Deploy to a specific port
werkerd deploy --port 3000
```

The server defaults to `root@18.171.244.124`. Override with:
```bash
export WERKERD_SERVER=root@my-server.com
```

### werkerd whoami

```bash
werkerd whoami
```

Shows the current server and deployed workers.

## Server Management

### Scale workers

```bash
# On the server
workerd-scale up <name> <port>      # Add an instance
workerd-scale down <name> <port>     # Remove an instance
workerd-scale list <name>           # Show all ports
```

### View logs

```bash
# Specific worker
journalctl -u workerd@my-worker:8080 -f

# All workerd services
journalctl -u 'workerd@*' -f

# Caddy logs
journalctl -u caddy -f
```

### System status

```bash
# Active services
systemctl list-units 'workerd@*' --no-legend

# Port usage
ss -tlnp | grep workerd

# All active ports
cat /etc/workerd/workers/*/ports
```

## Examples

All examples are standard npm projects. Deploy with `werkerd deploy`:

### Hello World
`examples/hello/` — Minimal worker with text binding
```bash
cd examples/hello
werkerd deploy --port 8084
curl http://18.171.244.124:8084/
```

### Hono Framework (first-class)
`examples/hono-app/` — Full Hono app with routing, JSON, HTML
```bash
cd examples/hono-app
npm install
werkerd deploy --port 8082
curl http://18.171.244.124:8082/
```

### Vite + React SSR (first-class)
`examples/vite-react/` — Vite React app with SSR on workerd
```bash
cd examples/vite-react
npm install
werkerd deploy --port 8083
curl http://18.171.244.124:8083/
```

### Durable Objects + WebSockets
`examples/fullstack/` — DO Counter, WebSocket ChatRoom, env vars
```bash
cd examples/fullstack
werkerd deploy --port 8085
curl http://18.171.244.124:8085/diag
```

### Service Bindings
`examples/api/` — API worker calling auth worker via `env.AUTH.fetch()`
```bash
# On server: workerd-scale up api 8090
curl http://18.171.244.124:8090/diag
```

## Environment Variables & Secrets

### Text bindings (in wrangler.jsonc)
For non-sensitive config values:
```jsonc
{ "vars": { "GREETING": "Hello!" } }
```
Values are embedded in the Cap'n Proto config. Available as `env.GREETING`.

### Secrets (.env file)
For sensitive values, create a `.env` file in your project:
```bash
# .env
SECRET_KEY=sk-abc123
DATABASE_URL=postgres://...
```
The CLI copies this to the server. The `workerd-start` script sources it before launching workerd. Available via `fromEnvironment` binding in the config.

## Binding Types

| Type | wrangler key | Cap'n Proto | Purpose |
|------|-------------|-------------|---------|
| Text | `vars` | `(name = "X", text = "Y")` | Static string values |
| Service | `services` | `(name = "X", service = "Y")` | Call another worker |
| Durable Object | `durable_objects.bindings` | `(name = "X", durableObjectNamespace = ...)` | DO access |
| KV namespace | `kv_namespaces` | `(name = "X", kvNamespace = ...)` | KV storage |
| R2 bucket | `r2_buckets` | `(name = "X", r2Bucket = ...)` | Object storage |
| D1 database | `d1_databases` | Wrapped binding | SQLite database |
| Queue | `queues.producers` | `(name = "X", queue = ...)` | Message queues |

## File System Layout (Server)

```
/etc/workerd/
  workers/
    <name>/
      index.js              ← Uploaded by CLI
      config.<port>.capnp   ← Generated per port
      .env                  ← Secrets (copied from project)
      ports                 ← Active port list (one per line)

/var/git/
  <name>.git/               ← Bare git repo for deploy (optional legacy)

/usr/local/bin/
  workerd-gen-config        ← Config generator (legacy manifest.json mode)
  workerd-start             ← systemd ExecStart wrapper
  workerd-scale             ← Scale manager
  workerd-gen-caddyfile     ← Caddyfile generator

/etc/systemd/system/
  workerd@.service          ← Template service unit
  workerd-<name>-<port>.socket  ← Per-instance socket unit

/etc/caddy/
  Caddyfile                 ← Auto-generated + manual
  Caddyfile.manual          ← User overrides
```

## Troubleshooting

### Service fails to start
```bash
systemctl status workerd@my-worker:8080
journalctl -u workerd@my-worker:8080 -n 50
```

Common causes:
- **Config validation error**: `workerd compile config.8080.capnp`
- **Missing embed file**: Ensure `index.js` exists, path is relative to config
- **Port in use**: `ss -tlnp | grep <port>`
- **Binding mismatch**: Binding names in wrangler.jsonc must match worker code

### Socket activation not triggering
```bash
systemctl status workerd-my-worker-8080.socket
ss -tlnp | grep <port>  # should show systemd listening
```

### Reset a broken service
```bash
systemctl stop workerd-my-worker-8080.socket
systemctl reset-failed workerd@my-worker:8080.service
# Redeploy or restart
```

## Bootstrap (New Server)

```bash
# 1. Copy scripts
scp management-scripts/* root@<host>:/tmp/werkerd-scripts/

# 2. Run bootstrap
ssh root@<host> bash /tmp/werkerd-scripts/bootstrap.sh

# 3. Install the CLI on your machine
cd werkerd-cli && npm install && npm link

# 4. Deploy!
cd examples/hello && werkerd deploy --port 8080
```

## Supported Features

| Feature | Status | Notes |
|---------|--------|-------|
| ES Modules | Supported | `export default { fetch }` |
| Service Workers | Supported | `addEventListener("fetch", ...)` |
| Hono | First-class | Full Hono framework support |
| Vite + React SSR | First-class | Build + deploy workflow |
| SvelteKit SSR | Supported | Build output as ES module |
| Service Bindings | Supported | `env.NAME.fetch()` |
| Durable Objects | Supported | Per-worker namespace, in-memory storage |
| WebSockets | Supported | `new WebSocketPair()` |
| Environment Variables | Supported | `.env` file + text bindings |
| KV Namespaces | Supported | Requires backend service |
| R2 Buckets | Supported | Requires backend service |
| Zero-downtime Deploy | Supported | Rolling restart via systemd |
| Socket Activation | Supported | systemd socket units |
| Caddy LB | Supported | Health-checked reverse proxy |
| Scale Up/Down | Supported | `workerd-scale` CLI |
| esbuild bundling | Supported | Auto-detects npm deps |

## Known Limitations

1. **KV, R2, D1 require backend services**: These bindings point to a service name. You need to configure the corresponding backend (or use in-memory stubs). The binding itself works — the backend is what you wire up.

2. **DO storage is in-memory**: Durable Object state persists only for the process lifetime. For production, configure `localDisk` or an external storage backend.

3. **No Cloudflare Dashboard**: Purely self-hosted. No UI for managing deployments.

4. **Single binary per instance**: Each systemd instance runs one workerd process. Group workers share the same process isolate.

5. **No cross-server replication**: Durable Objects stored locally. No automatic replication across servers.

6. **Caddy reload may drop connections**: Use with caution in production. Consider zero-downtime Caddy restart strategies.
