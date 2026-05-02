# System Architecture

## Overview

WERKERD is a self-hosted Cloudflare Workers runtime built on `workerd` (Cloudflare's open-source Workers runtime), managed by systemd socket activation, fronted by Caddy for SSL and load balancing, and deployed via git push.

```
                         Internet
                            |
                        [Caddy :80]
                       /      |      \
                 localhost   localhost  localhost
                    :8080     :8081     :8090
                      |         |         |
                 [systemd socket units]   |
                      |         |         |
                 [workerd @ hello:8080]   |
                 [workerd @ hello:8081]   |
                                          |
                                   [workerd @ api:8090]
                                    /                    \
                              [api worker]           [auth worker]
                              env vars               service binding
                              ES modules             token validation
```

## Component Layers

### Layer 1: Edge Proxy (Caddy)

- Terminates TLS
- Health-checks worker instances
- Load balances across instances
- Provides access logging

### Layer 2: Systemd Socket Activation

- Listens on ports via socket units
- Lazily spawns worker processes on first request
- Provides automatic restart on crash
- Manages resource limits (CPU, memory)

### Layer 3: workerd Runtime

- The Cloudflare open-source Workers runtime
- Runs JavaScript/WebAssembly workers
- Supports service bindings, KV, DO, R2, Queues

### Layer 4: Worker Code

- ES Module or Service Worker format
- Access to env vars, service bindings
- Standard Web APIs (fetch, Request, Response, URL, etc.)

## Directory Layout

```
/etc/workerd/
  workers/
    hello/                     ← Worker "hello"
      worker.js                ← Entrypoint source
      manifest.json            ← Worker metadata
      .env                     ← Environment variables
      config.8080.capnp        ← Generated per-port config
      config.8081.capnp        ← (multiple ports = multiple configs)
      ports                    ← Active port list (one per line)
    api/                       ← Worker "api" (group leader)
      worker.js
      manifest.json
      .env
      config.8090.capnp
      ports
      group-auth.js            ← Copied group member
    auth/                      ← Worker "auth" (group member)
      worker.js                ← Deployed by api's post-receive hook

/var/git/
  hello.git/                   ← Bare git repo for worker "hello"
    hooks/post-receive         ← Deploy hook
  api.git/                     ← Bare git repo for worker "api"

/var/lib/workerd/              ← State (KV, DO storage, etc.)
/usr/local/bin/
  workerd-gen-config           ← Config generator
  workerd-start                ← systemd ExecStart wrapper
  workerd-scale                ← Scale up/down/list
  workerd-gen-caddyfile        ← Caddyfile generator
  workerd-deploy               ← Manual deploy script

/etc/systemd/system/
  workerd@.service             ← Template service unit
  workerd-hello-8080.socket    ← Per-instance socket unit
  workerd-hello-8081.socket
  workerd-api-8090.socket

/etc/caddy/
  Caddyfile                    ← Generated Caddy config
  Caddyfile.manual             ← Manual Caddy entries (merged)
```

## Configuration Flow

```
manifest.json ──→ workerd-gen-config ──→ config.<port>.capnp ──→ workerd serve
    │                     │                                            │
    │                     ├── group members ──────────────────────────┘
    │                     │   (copied as group-{name}.js)
    │                     │
    │                     ├── env vars (.env) ────────────────────────┘
    │                     │
    │                     └── bindings ──────────────────────────────┘
    │
    └── manifest schema:
        {
          "name": "worker-name",
          "compatibilityDate": "2024-09-23",
          "entrypoint": "worker.js",
          "group": ["leader", "member1", "member2"],
          "bindings": [
            { "name": "AUTH", "service": "auth" },
            { "name": "KV", "kvNamespace": "cache" },
            { "name": "BUCKET", "r2Bucket": "assets" }
          ],
          "env": ["SECRET_KEY", "API_URL"]
        }
```

## Deploy Flow

```
git push deploy main
     │
     ▼
post-receive hook
     │
     ├── Check out worker.js
     ├── Sync group members (auth-worker.js, etc.)
     ├── Regenerate config for each port
     │      └── workerd-gen-config <worker> <port>
     ├── Rolling restart
     │      └── systemctl restart workerd@<worker>:<port> (one at a time)
     └── Done (responds to git push)
```

## Network Flow

```
Browser ──HTTPS──▶ Caddy (:443) ──HTTP──▶ workerd (:8080) ──▶ Worker code
                                        └──▶ workerd (:8081) ──▶ Worker code

Health checks:
Caddy ──GET /healthz──▶ workerd (:8080) ──▶ 200 OK
Caddy ──GET /healthz──▶ workerd (:8081) ──▶ 200 OK
```

## Service Binding Flow

```
  ┌──────────────────────────────────────────┐
  │     workerd process (api:8090)             │
  │                                            │
  │  ┌──────────┐    env.AUTH.fetch()    ┌────┐│
  │  │ api      │ ──────────────────────▶│auth││
  │  │ worker   │◀────────────────────── │    ││
  │  └──────────┘   Response (in-process)└────┘│
  │                                            │
  └──────────────────────────────────────────┘
```

Service bindings use in-process HTTP — no network overhead.

## Durable Objects Flow

```
  ┌─────────────────────────────────────┐
  │     workerd process (:9000)          │
  │                                      │
  │  ┌──────────┐  ctx.env.COUNTER       │
  │  │ worker   │ ──────────────▶ [DO Stub] ──▶ Counter DO instance
  │  │          │◀──────────────              │   • idFromName("global")
  │  └──────────┘   Response                  │   • getCounterValue()
  │                                           │   • increment(amount)
  │  ┌──────────┐  ctx.env.CHATROOM           │   • SQLite-backed storage
  │  │ worker   │ ───────────────────▶ [DO Stub] ──▶ ChatRoom DO instance
  │  └──────────┘                                │   • idFromName("room1")
  │                                              │   • getMessages()
  │                                              │   • addMessage()
  └──────────────────────────────────────────────┘
```
