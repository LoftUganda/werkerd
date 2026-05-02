# werkerd — Skill

## Overview

`werkerd` is a skill for deploying and managing self-hosted Cloudflare Workers runtimes using the open-source `workerd` binary. It provides zero-downtime deployments, socket activation, Caddy reverse proxying, and a git-push deploy pipeline — all running on your own Ubuntu infrastructure without any Cloudflare account.

## When to Use This Skill

Load this skill when:
- Deploying a worker to a self-hosted workerd server (`ubuntu@18.171.244.124`)
- Setting up a new worker with service bindings, Durable Objects, KV, or WebSockets
- Scaling a worker up/down across multiple ports
- Troubleshooting systemd, Caddy, or workerd config issues
- Adding secrets or environment variables to workers
- Setting up a new server from scratch

## Architecture

```
┌──────────────────────────────────────────────────┐
│                  Internet                         │
└─────────────────┬────────────────────────────────┘
                  │ :80, :443
                  ▼
┌──────────────────────────────────────────────────┐
│  Caddy (reverse proxy + auto TLS)                │
│  /etc/caddy/Caddyfile                            │
└─────────────┬────────────┬───────────────────────┘
              │            │
     localhost:8080  localhost:8081  (up to N ports)
              │            │
              ▼            ▼
┌──────────────────────────────────────────────────┐
│  systemd socket activation                       │
│  workerd-hello-8080.socket → workerd@hello:8080  │
│  workerd-hello-8081.socket → workerd@hello:8081  │
└──────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────┐
│  workerd process (per instance)                  │
│  /usr/bin/workerd serve config.{port}.capnp      │
│  --socket-fd http=3                              │
└──────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────┐
│  /etc/workerd/workers/<name>/                    │
│    worker.js          ← git push deploy          │
│    manifest.json       ← worker config           │
│    config.{port}.capnp ← generated per port      │
│    .env                ← environment variables   │
│    ports               ← active port list        │
└──────────────────────────────────────────────────┘
```

## Prerequisites

| Component | Minimum Version | Purpose |
|-----------|----------------|---------|
| Ubuntu | 20.04+ | Server OS |
| Node.js | 18.x+ | Config generator runtime |
| workerd | latest npm | Workers runtime |
| Caddy | 2.x | Reverse proxy + TLS |
| systemd | 245+ | Socket activation |

## Management Scripts

All scripts are installed at `/usr/local/bin/`:

| Script | Purpose | Usage |
|--------|---------|-------|
| `workerd-gen-config` | Generate Cap'n Proto config from manifest | `workerd-gen-config <name> <port>` |
| `workerd-start` | systemd ExecStart wrapper | Called by systemd only |
| `workerd-scale` | Scale worker across ports | `workerd-scale up\|down\|list <name> [port]` |
| `workerd-gen-caddyfile` | Generate Caddy upstream config | `workerd-gen-caddyfile` |
| `workerd-deploy` | Manual deploy (alternative to git push) | `workerd-deploy <name>` |

### Configuration Generation

The `workerd-gen-config` script reads a worker's `manifest.json` and produces a Cap'n Proto config file. The config generator auto-detects module type (ES module vs service worker) and supports all binding types.

### Scaling

The `workerd-scale` script manages per-port socket units:
- `workerd-scale up <worker> <port>` — Generates config, creates socket unit, starts systemd service
- `workerd-scale down <worker> <port>` — Stops service, removes socket unit, cleans up
- `workerd-scale list <worker>` — Shows active instances and registered ports

Port conflict detection prevents duplicates across workers.

## Worker Manifest Format

Each worker has a `manifest.json` at `/etc/workerd/workers/<name>/manifest.json`:

```json
{
  "name": "my-worker",
  "entrypoint": "worker.js",
  "compatibilityDate": "2024-09-23",
  "moduleType": "esm",
  "group": ["my-worker"],
  "bindings": [
    { "type": "service",           "name": "AUTH",    "service": "auth-svc" },
    { "type": "durableObjectNamespace", "name": "COUNTER", "className": "Counter" },
    { "type": "kvNamespace",       "name": "STORE",   "service": "kv-service" },
    { "type": "r2Bucket",          "name": "BUCKET",  "service": "r2-service" },
    { "type": "queue",             "name": "TASKS",   "service": "queue-service" },
    { "type": "fromEnvironment",   "name": "SECRET_KEY" },
    { "type": "text",              "name": "CONFIG",  "text": "some static text" },
    { "type": "json",              "name": "SETTINGS","json": "{}" },
    { "type": "memoryCache",       "name": "CACHE",   "id": "my-cache" },
    { "type": "unsafeEval",        "name": "EVAL" },
    { "type": "hyperdrive",        "name": "DB",
      "designator": "my-db", "database": "mydb", "user": "admin",
      "password": "pass", "scheme": "postgres" },
    { "type": "cryptoKey",         "name": "SIGNING_KEY",
      "algorithm": "Ed25519", "hex": "abcdef..." },
    { "type": "analyticsEngine",   "name": "ANALYTICS", "service": "ae-service" }
  ],
  "env": ["SECRET_KEY", "OTHER_VAR"],
  "durableObjects": [
    {
      "className": "Counter",
      "uniqueKey": "global-counter-key-v1",
      "preventEviction": true,
      "enableSql": true
    }
  ],
  "durableObjectStorage": "inMemory",
  "tailWorkers": ["tail-svc"],
  "disableInternet": false
}
```

### Binding Types Reference

| Type | Config Field | Required Props | Purpose |
|------|-------------|---------------|---------|
| `service` | Service binding | `name`, `service` | Call another worker via `env.NAME.fetch()` |
| `durableObjectNamespace` | DO namespace | `name`, `className` | Access Durable Objects via `env.NAME` |
| `kvNamespace` | KV namespace | `name`, `service` | KV storage binding |
| `r2Bucket` | R2 bucket | `name`, `service` | Object storage binding |
| `queue` | Queue | `name`, `service` | Message queue binding |
| `fromEnvironment` | Env variable | `name` | Load from `.env` file (added automatically for `env` array entries) |
| `text` | Text binding | `name`, `text` | Static string value |
| `json` | JSON binding | `name`, `json` | Static JSON value |
| `memoryCache` | Memory cache | `name`, `id` | In-memory cache binding |
| `unsafeEval` | Unsafe eval | `name` | Permits `eval()` in worker |
| `hyperdrive` | Database proxy | `name`, `designator`, `database`, `user`, `password`, `scheme` | PostgreSQL/MySQL proxy |
| `cryptoKey` | Crypto key | `name`, `algorithm`, `jwk` or `hex` or `file` | Named crypto key |
| `analyticsEngine` | Analytics engine | `name`, `service` | Analytics binding |

### Module Type Detection

The config generator auto-detects module type by scanning the entrypoint file:
- If the file starts with `import` or `export`, it's treated as an ES module
- Otherwise, it's treated as a service worker
- Override with `"moduleType": "esm"` or `"moduleType": "service-worker"` in manifest

## Environment Variables

Create a `.env` file alongside `worker.js`:

```bash
# /etc/workerd/workers/my-worker/.env
SECRET_KEY=sk-abc123def456
API_ENDPOINT=https://api.example.com
```

The `workerd-start` script sources this file before launching workerd. Only variables listed in the manifest's `env` array are exposed to the worker via `env.VAR_NAME`.

## Git Deploy Pipeline

Each worker has a bare git repository at `/var/git/<name>.git` with a `post-receive` hook:

1. Developer pushes to `main` branch
2. Hook checks out `worker.js` to `/etc/workerd/workers/<name>/`
3. Regenerates Cap'n Proto configs for all active ports
4. Performs rolling restart across all instances (sequential, 500ms apart)
5. Zero-downtime: other instances handle traffic during each restart

### Setup

```bash
# On the server
mkdir -p /var/git/my-worker.git
cd /var/git/my-worker.git
git init --bare
git symbolic-ref HEAD refs/heads/main

# Install the post-receive hook (edit WORKER placeholder)
cp /path/to/post-receive hooks/post-receive
sed -i 's/PLACEHOLDER/my-worker/' hooks/post-receive
chmod +x hooks/post-receive
```

### Deploying

```bash
# From your local machine
git remote add deploy ssh://deploy@18.171.244.124:/var/git/my-worker.git
git push deploy main
```

## Caddy Configuration

Caddy provides the reverse proxy layer. Configuration:

- **Auto-generated**: `workerd-gen-caddyfile` reads `/etc/workerd/workers/*/ports` and generates upstream blocks with health-checked load balancing
- **Manual overrides**: `/etc/caddy/Caddyfile.manual` is appended to the auto-generated config
- **Health checks**: Workers should expose `/healthz` returning `200 OK`

Example manual Caddyfile entry:
```
:80 {
    reverse_proxy localhost:8080 localhost:8081 {
        lb_policy       least_conn
        health_uri      /healthz
        health_interval 10s
        health_timeout  3s
    }
}
```

Reload Caddy after changes:
```bash
sudo caddy reload --config /etc/caddy/Caddyfile
```

## Observability

### Logs
```bash
# View worker logs
journalctl -u workerd@my-worker:8080 -f

# View all workerd services
journalctl -u 'workerd@*' -f

# View Caddy logs
journalctl -u caddy -f
```

### Metrics
```bash
# Active services
systemctl list-units 'workerd@*' --no-legend

# Port usage
ss -tlnp | grep workerd

# Instance count
cat /etc/workerd/workers/*/ports
```

## Troubleshooting

### Service fails to start
```bash
systemctl status workerd@my-worker:8080
journalctl -u workerd@my-worker:8080 -n 50
```

Common causes:
- **Config validation error**: Run `workerd compile config.8080.capnp` to validate
- **Missing embed file**: Ensure `worker.js` exists and paths are relative to config file
- **Port in use**: Check with `ss -tlnp | grep <port>`
- **Binding mismatch**: Binding names in manifest must match worker code's `env.NAME` references

### Socket activation not triggering
```bash
systemctl status workerd-my-worker-8080.socket
ss -tlnp | grep 8080  # should show systemd listening
```

### Caddy not routing
```bash
caddy validate --config /etc/caddy/Caddyfile
curl -sv http://localhost:<port>/  # test direct access first
```

### Git push deploy not updating
```bash
cat /var/git/my-worker.git/hooks/post-receive  # verify WORKER name
sudo git --git-dir=/var/git/my-worker.git log --oneline  # verify commits
```

## File System Layout

```
/etc/workerd/
  workers/
    <name>/
      worker.js           ← Entrypoint (deployed via git push)
      manifest.json        ← Worker configuration
      config.<port>.capnp  ← Generated Cap'n Proto config
      .env                 ← Environment variables (optional)
      ports                ← Active port list (one per line)
      group-<name>.js      ← Group member workers (copied from sibling dirs)

/var/lib/workerd/
  workers/                 ← Durable Object storage (if using localDisk)

/var/git/
  <name>.git/              ← Bare git repo for each worker
    hooks/post-receive     ← Deploy hook

/usr/local/bin/
  workerd-gen-config       ← Config generator
  workerd-start             ← systemd exec wrapper
  workerd-scale             ← Scale manager
  workerd-gen-caddyfile     ← Caddyfile generator
  workerd-deploy            ← Manual deploy CLI

/etc/systemd/system/
  workerd@.service         ← Template service unit
  workerd-<name>-<port>.socket  ← Per-instance socket unit

/etc/caddy/
  Caddyfile                ← Auto-generated + manual entries
  Caddyfile.manual         ← User overrides
```

## Bootstrap (New Server)

```bash
# 1. Copy all management scripts to /tmp/werkerd-scripts/
scp management-scripts/* ubuntu@<host>:/tmp/werkerd-scripts/

# 2. Run bootstrap
ssh ubuntu@<host> sudo bash /tmp/werkerd-scripts/bootstrap.sh

# 3. Create Caddyfile
sudo tee /etc/caddy/Caddyfile.manual << 'EOF'
:80 {
    reverse_proxy localhost:8080 {
        health_uri /healthz
    }
}
EOF
sudo /usr/local/bin/workerd-gen-caddyfile
sudo caddy reload --config /etc/caddy/Caddyfile

# 4. Deploy first worker
sudo /usr/local/bin/workerd-scale up hello 8080

# 5. Test
curl http://localhost:8080/
```

## Supported Features

| Feature | Status | Notes |
|---------|--------|-------|
| ES Modules | Supported | Auto-detected from source |
| Service Workers | Supported | `addEventListener("fetch", ...)` pattern |
| Service Bindings | Supported | `env.NAME.fetch()` to call other workers in the same group |
| Durable Objects | Supported | Binding type `durableObjectNamespace` |
| KV Namespaces | Supported | Binding type `kvNamespace` (local in-memory or external service) |
| R2 Buckets | Supported | Binding type `r2Bucket` |
| Queues | Supported | Binding type `queue` |
| WebSockets | Supported | `new WebSocketPair()`, chatroom pattern |
| Environment Variables | Supported | `.env` file + `env` array in manifest |
| Text/JSON Bindings | Supported | Static config values |
| Hyperdrive | Supported | Database proxy binding |
| Memory Cache | Supported | In-memory key-value cache |
| Crypto Keys | Supported | JWK, hex, or raw file |
| Analytics Engine | Supported | Binding to analytics service |
| Unsafe Eval | Supported | Opt-in `eval()` permission |
| Zero-downtime Deploy | Supported | Rolling restart via systemd |
| Socket Activation | Supported | systemd socket units |
| Caddy LB | Supported | Health-checked load balancing |
| Git Push Deploy | Supported | Post-receive hook |
| Scale Up/Down | Supported | `workerd-scale` CLI |
| SvelteKit SSR | Supported | Hybrid rendering via `adapter-cloudflare` output |

## Known Limitations

1. **Config-level DO fields**: `durableObjectNamespaces` and `durableObjectStorage` at the Config struct level are not yet supported by the current workerd binary. Durable Objects work via Worker-level binding only.

2. **No secrets manager**: Environment variables stored in `.env` files on disk. No built-in secrets vault integration yet.

3. **No Cloudflare Dashboard**: This is purely self-hosted — no UI for managing deployments.

4. **Single binary per instance**: Each systemd instance runs one workerd process. Group workers share the same process isolate.

5. **No global replication**: Durable Objects stored locally. No cross-server replication.

6. **Caddy reload resets connections**: `caddy reload` may briefly drop active connections. Use with caution in production.]]>