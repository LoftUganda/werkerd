# werkerd — Complete Guide

## Overview

`werkerd` is a self-hosted Cloudflare Workers runtime. It lets you deploy any Cloudflare Workers project to your own server using `workerd` — the real Cloudflare Workers runtime, open-sourced by Cloudflare.

**Server**: `YOUR_USER@YOUR_SERVER` (Ubuntu 22.04+)

The goal is parity with Cloudflare Workers DX for self-hosted code. No Cloudflare account needed.

---

## Quickstart

```bash
# 1. Install the CLI
cd werkerd-cli && npm install && npm link

# 2. Deploy any Cloudflare Workers project
cd ~/my-worker
werkerd deploy --port 8080

# That's it. Zero config editing.
```

---

## When to Use This Skill

Load this skill when:
- Deploying a worker to `YOUR_USER@YOUR_SERVER`
- Setting up service bindings, Durable Objects, KV, or WebSockets
- Scaling a worker up/down across ports
- Troubleshooting systemd, nginx, or workerd issues
- Adding environment variables or secrets
- Setting up a new server from scratch

---

## Architecture

```
                          Internet
                             │
                         nginx :80
                        /   |   |   \
              hello.    hono-app.  fullstack. vite-react.
              localhost    localhost    localhost    localhost
                             │        │        │
              ┌─────────────┴────────┴────────┘
              │
         systemd socket activation
         workerd-hello-8080.socket → workerd@hello:8080.service
         workerd-hello-8081.socket → workerd@hello:8081.service
              │
         workerd processes
         /usr/bin/workerd serve config.<port>.capnp --socket-fd http=3
              │
         /etc/workerd/workers/<name>/
           index.js              ← uploaded by CLI
           config.<port>.capnp   ← generated per port
           .env                  ← environment variables
           scale                 ← instance count (1, 2, 3...)
           ports                  ← active port list
```

### Component Layers

**Layer 1: nginx** (reverse proxy)
- Routes by hostname (`hello.localhost`, `hono-app.localhost`, etc.)
- Load balances across multiple instances using `least_conn` algorithm
- Provides `/nginx_status` monitoring endpoint
- `proxy_next_upstream` handles failover automatically

**Layer 2: systemd socket activation**
- Listens on ports via socket units
- Lazily spawns workerd processes on first request
- Survives service restarts — no dropped connections

**Layer 3: workerd runtime**
- The actual Cloudflare Workers runtime
- Runs JavaScript/WebAssembly workers
- Supports all Cloudflare APIs: DO, KV, R2, WebSockets, etc.

**Layer 4: Worker code**
- ES Module format: `export default { fetch }`
- Service Worker format: `addEventListener("fetch", ...)`
- Access to `env.*` bindings

---

## Project Format

Any project with `wrangler.jsonc` works. Standard Cloudflare Workers structure:

```
my-project/
├── wrangler.jsonc       ← read by werkerd deploy
├── package.json          ← optional, for bundling
├── src/
│   └── index.js         ← entrypoint
└── .env                 ← optional, secrets
```

---

## wrangler.jsonc Reference

`werkerd deploy` reads standard Cloudflare `wrangler.jsonc` fields. Same format as `wrangler deploy` — no config changes needed.

```jsonc
{
  "name": "my-worker",
  "main": "src/index.js",
  "compatibility_date": "2024-09-23",

  // Text bindings — static strings embedded in config
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

  // Service bindings — call other workers in same process
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

### wrangler.jsonc → Cap'n Proto Mapping

| wrangler.jsonc field | Cap'n Proto | Purpose |
|---------------------|-----------|---------|
| `vars` | `text = "..."` | Static string values |
| `kv_namespaces` | `kvNamespace = "..."` | KV storage binding |
| `r2_buckets` | `r2Bucket = "..."` | Object storage binding |
| `d1_databases` | wrapped binding | SQLite database |
| `durable_objects.bindings` | `durableObjectNamespace = ...` | DO binding |
| `services` | `service = "..."` | Service binding (in-process call) |
| `queues.producers` | `queue = "..."` | Message queue |

---

## CLI Commands

### werkerd deploy

```bash
werkerd deploy [--port <port>]
```

What it does:
1. Reads `wrangler.jsonc` from current directory
2. Auto-detects npm dependencies
3. Bundles with esbuild if needed (`import` statements, Hono, etc.)
4. Generates Cap'n Proto config for workerd
5. Copies `.env` from project (if exists) for secrets
6. Uploads everything to server via SCP
7. Creates systemd socket unit and starts the service
8. Regenerates nginx config and reloads nginx
9. Health-checks the endpoint

```bash
# Deploy to default port 8080
werkerd deploy

# Deploy to specific port
werkerd deploy --port 3000

# Override server
export WERKERD_SERVER=root@my-server.com
werkerd deploy --port 8080
```

### werkerd whoami

```bash
werkerd whoami
```

Shows the current server and deployed workers.

---

## Server Management

### workerd-scale

Git-driven scaling CLI.

```bash
# Show CPU cores and scaling advice
ssh YOUR_USER@YOUR_SERVER workerd-scale info

# Set instance count (git-driven workflow)
# 1. Edit /etc/workerd/workers/<worker>/scale locally
# 2. Push to server
# 3. Server applies: workerd-scale set <worker> <N>
workerd-scale set <worker> <N>

# Start a new worker
workerd-scale start <worker> <port>

# Stop all instances
workerd-scale stop <worker>

# Show status
workerd-scale list <worker>
```

**Git-driven scaling workflow**:
```bash
# Locally: edit the scale file
echo 2 > /etc/workerd/workers/hello/scale
git add -A && git commit && git push

# On server (via post-receive hook or manual):
workerd-scale set hello 2
```

**Scaling advice**:
- 1 core: scaling won't help — deploy to more cores
- 2 cores: marginal benefit (context switching)
- 4+ cores: scaling works linearly — set instances = cores

### View logs

```bash
# All workerd services
journalctl -u 'workerd@*' -f

# Specific worker (all instances)
journalctl -u 'workerd@hello:*' -f

# Single instance
journalctl -u 'workerd@hello:8080.service' -n 50

# nginx access logs
tail -f /var/log/nginx/workerd-access.log

# nginx error logs
tail -f /var/log/nginx/workerd-error.log
```

### System status

```bash
# Active services
systemctl list-units 'workerd@*' --no-legend --state=active

# All sockets
systemctl list-units 'workerd-*-*.socket' --no-legend

# Listening ports
ss -tlnp | grep workerd

# nginx status (monitoring)
curl http://localhost/nginx_status

# Active connections breakdown
ss -s
```

---

## Examples

All examples are standard npm projects. Deploy with `werkerd deploy`:

### Hello World
```bash
cd examples/hello
werkerd deploy --port 8080
curl http://hello.localhost/
curl http://YOUR_SERVER:8080/
```

### Hono Framework
```bash
cd examples/hono-app
npm install
werkerd deploy --port 8082
curl http://hono-app.localhost/
curl http://hono-app.localhost/hello/world
curl -X POST http://hono-app.localhost/echo -d '{"msg":"hi"}'
```

### Vite + React SSR
```bash
cd examples/vite-react
npm install
werkerd deploy --port 8083
curl http://vite-react.localhost/api/info
```

### Fullstack (DO + WebSockets + Env Vars)
```bash
cd examples/fullstack
werkerd deploy --port 8085
curl http://fullstack.localhost/diag
curl -X POST http://localhost:8085/counter/increment
curl http://localhost:8085/kv/testkey?value=hello
```

---

## Environment Variables & Secrets

### .env file (recommended for secrets)

Create a `.env` file in your project:

```bash
SECRET_KEY=sk-abc123
DATABASE_URL=postgres://...
DEBUG=false
```

The CLI copies this to the server at `/etc/workerd/workers/<name>/.env`. The `workerd-start` script sources it before launching workerd.

Access in worker code:
```javascript
export default {
  fetch(request, env) {
    const key = env.SECRET_KEY;  // "sk-abc123"
    const db = env.DATABASE_URL; // "postgres://..."
  }
};
```

### Text bindings (wrangler.jsonc vars)

For non-secret config values, use `vars` in wrangler.jsonc:

```jsonc
"vars": {
  "GREETING": "Hello!",
  "APP_ENV": "production"
}
```

Values are embedded directly in the Cap'n Proto config. Available as `env.GREETING`.

---

## Binding Types

| Type | wrangler.jsonc | Cap'n Proto | Worker Access |
|------|---------------|-------------|--------------|
| Text | `vars` | `text = "..."` | `env.VAR` |
| Service | `services` | `service = "name"` | `env.BINDING.fetch()` |
| Durable Object | `durable_objects` | `durableObjectNamespace = (...)` | `env.BINDING.idFromName()` |
| KV | `kv_namespaces` | `kvNamespace = "..."` | `env.BINDING.get()/put()` |
| R2 | `r2_buckets` | `r2Bucket = "..."` | `env.BINDING.get()` |
| Queue | `queues.producers` | `queue = "..."` | `env.BINDING.send()` |
| D1 | `d1_databases` | wrapped | `env.BINDING.prepare()` |
| Env var | `.env` file | `fromEnvironment = "NAME"` | `env.NAME` |

---

## File System Layout (Server)

```
/etc/workerd/
  workers/
    <name>/
      index.js              ← uploaded by CLI (or git hook)
      config.<port>.capnp   ← generated per port+instance
      .env                  ← secrets (copied by CLI)
      scale                 ← instance count (1, 2, 3...)
      ports                 ← active port list

/var/git/
  <name>.git/              ← bare git repo for git-push deploy

/usr/local/bin/
  workerd-scale             ← scaling CLI
  workerd-gen-nginx        ← nginx config generator
  workerd-gen-config       ← Cap'n Proto config generator
  workerd-start            ← systemd ExecStart wrapper

/etc/systemd/system/
  workerd@.service         ← template service unit
  workerd-<name>-<port>.socket  ← per-instance socket unit

/etc/nginx/
  sites-available/workerd  ← auto-generated per-worker upstreams
  sites-enabled/workerd
```

---

## Bootstrap (New Server)

```bash
# 1. On your local machine: copy scripts to server
scp -r management-scripts/* root@<new-server>:/tmp/werkerd-scripts/

# 2. On server: run bootstrap as root
ssh root@<new-server>
bash /tmp/werkerd-scripts/bootstrap.sh

# 3. On your local machine: install CLI
cd werkerd-cli && npm install && npm link

# 4. Deploy!
cd examples/hello && werkerd deploy --port 8080
```

The bootstrap script:
- Installs Node.js 20.x
- Installs workerd globally
- Installs and configures nginx
- Creates the `workerd` system user
- Creates all required directories
- Installs management scripts to `/usr/local/bin/`
- Installs systemd service units
- Creates the `deploy` user for git-push deployments
- Enables nginx

---

## Troubleshooting

### Service fails to start

```bash
# Check status
systemctl status workerd@hello:8080.service

# Check logs
journalctl -u workerd@hello:8080.service -n 50 --no-pager

# Common errors:
# "No such file: config.8080.capnp" → run: workerd-gen-config hello 8080
# "embed path not found" → worker file missing or wrong path
# "ES module parse error" → use service worker format or set moduleType
```

### nginx not proxying

```bash
# Check nginx is running
systemctl status nginx

# Test config
nginx -t

# Reload
systemctl reload nginx

# Check access
curl http://hello.localhost/

# Direct vs nginx
curl http://localhost:8080/      # should work (direct)
curl http://hello.localhost/     # should work (via nginx)
```

### Socket activation not triggering

```bash
# Check socket is listening
systemctl status workerd-hello-8080.socket
ss -tlnp | grep :8080  # should show systemd listening

# Trigger manually
curl http://localhost:8080/

# If still not working, check the socket unit file
cat /etc/systemd/system/workerd-hello-8080.socket
```

### Scale not taking effect

```bash
# Check scale file
cat /etc/workerd/workers/hello/scale

# Check running instances
workerd-scale list hello

# Apply manually
workerd-scale set hello 2
```

---

## Supported Features

| Feature | Status | Notes |
|---------|--------|-------|
| ES Modules | ✅ | `export default { fetch }` |
| Service Workers | ✅ | `addEventListener("fetch", ...)` |
| Hono | ✅ First-class | Full Hono framework |
| Vite + React SSR | ✅ First-class | Build + deploy |
| SvelteKit SSR | ✅ | Build output as ES module |
| Service Bindings | ✅ | `env.NAME.fetch()` in same process |
| Durable Objects | ✅ | In-memory (localDisk optional) |
| WebSockets | ✅ | `new WebSocketPair()` |
| Environment Variables | ✅ | `.env` file + text bindings |
| KV Namespaces | ✅ | Requires backend (or in-memory stub) |
| R2 Buckets | ✅ | Requires backend (or stub) |
| D1 Databases | ✅ | Requires backend |
| Zero-downtime Deploy | ✅ | Rolling restart via systemd |
| Socket Activation | ✅ | systemd socket units |
| nginx LB | ✅ | hostname routing + load balancing |
| Git-driven Scaling | ✅ | `workerd-scale set <N>` |
| esbuild bundling | ✅ | Auto-detects npm deps |

---

## Known Limitations

1. **KV, R2, D1 require a backend**: The binding works but needs a service to back it. For local dev, use in-memory stubs.

2. **DO storage is in-memory by default**: State survives restarts within the process lifetime. Configure `localDisk` for persistence.

3. **Scaling only helps with more CPU cores**: workerd is single-threaded. On a 2-core VM, 2 instances compete for the same cores. On 4+ cores, scaling is linear.

4. **No multi-server replication**: Durable Objects are local to one server. For HA, run multiple servers with a load balancer in front.

5. **`werkerd deploy` creates `manifest.json` automatically**: The CLI now writes `manifest.json` to the server after deploy, so `workerd-scale set/start` works immediately without manual setup.

6. **`workerd-scale set` skips existing socket units**: Socket units are now only created if they don't exist, so scaling won't interrupt running instances.

---

## Performance

**Load test results** (2-core VM, Ubuntu 24.04):

| Configuration | RPS | p50 | p99 |
|---|---|---|---|
| Direct workerd (1 instance, localhost) | 8,957 | 13ms | 93ms |
| nginx LB (1 backend) | 8,118 | 21ms | 143ms |
| nginx LB (2 backends) | 8,327 | 20ms | 171ms |
| Hono app via nginx | 2,575 | 15ms | 35ms |
| Fullstack DO via nginx | 6,846 | 26ms | 1.04s |

**Per-core throughput**: ~4,500-8,900 RPS depending on workload.

**Linear scaling confirmed** on multi-core machines (4+ cores).

**To reach 1M RPS**: ~120 cores at ~8,000 RPS/core behind nginx.

---

## nginx Configuration

Generated by `workerd-gen-nginx`, applied automatically on deploy/scale.

Key settings:
- `least_conn` — distributes load evenly
- `keepalive 100` — upstream connection pool
- `zone workerd_<worker>_upstream 64k` — shared memory for LB state
- `proxy_next_upstream error timeout http_502 http_503 http_504` — failover

Monitoring:
```bash
curl http://localhost/nginx_status
```

Example upstream:
```nginx
upstream workerd_hello {
    zone workerd_hello_upstream 64k;
    least_conn;
    keepalive 100;
    server 127.0.0.1:8080 max_fails=3 fail_timeout=10s;
    server 127.0.0.1:8081 max_fails=3 fail_timeout=10s;
}
```