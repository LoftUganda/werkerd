# Configuration Reference

## wrangler.jsonc Reference

`werkerd deploy` reads standard Cloudflare `wrangler.jsonc` fields. All fields are optional unless noted.

```jsonc
{
  // REQUIRED: Worker name (must be unique, used in routes and directories)
  "name": "my-worker",

  // REQUIRED: Entrypoint path relative to project root
  "main": "src/index.js",

  // REQUIRED: Cloudflare compatibility date (YYYY-MM-DD)
  "compatibility_date": "2024-09-23",

  // OPTIONAL: Port for direct access (default: 8080)
  "port": 8080,

  // --- BINDINGS ---

  // Static text values embedded in the Cap'n Proto config
  // Available as env.VAR_NAME in worker code
  "vars": {
    "GREETING": "Hello!",
    "APP_ENV": "production"
  },

  // KV namespaces — key-value storage
  "kv_namespaces": [
    { "binding": "STORE", "id": "my-store" }
  ],

  // R2 object storage buckets
  "r2_buckets": [
    { "binding": "ASSETS", "bucket_name": "my-bucket" }
  ],

  // D1 SQLite databases
  "d1_databases": [
    { "binding": "DB", "database_id": "my-db" }
  ],

  // Durable Objects — stateful serverless objects
  "durable_objects": {
    "bindings": [
      { "name": "COUNTER", "class_name": "Counter" },
      { "name": "ROOM",    "class_name": "ChatRoom" }
    ]
  },

  // Service bindings — in-process calls to other workers
  "services": [
    { "binding": "AUTH", "service": "auth-worker" }
  ],

  // Queue producers — send messages to queues
  "queues": {
    "producers": [
      { "binding": "TASKS", "queue": "task-queue" }
    ]
  },

  // --- ROUTING (for nginx) ---

  // Custom routes (handled by nginx)
  "routes": [
    { "pattern": "api.example.com", "zone": "example.com" }
  ],

  // Static assets directory
  "assets": {
    "directory": "public",
    "binding": "ASSETS"
  }
}
```

### wrangler.jsonc → Cap'n Proto Mapping

| wrangler.jsonc field | Cap'n Proto | Worker Access |
|---------------------|-----------|---------------|
| `vars` | `text = "..."` | `env.VAR` |
| `kv_namespaces` | `kvNamespace = (service = "...")` | `env.BINDING.get()/put()` |
| `r2_buckets` | `r2Bucket = "..."` | `env.BINDING.get()/put()` |
| `d1_databases` | wrapped | `env.BINDING.prepare()` |
| `durable_objects.bindings` | `durableObjectNamespace = (className = "...")` | `env.BINDING.idFromName()` |
| `services` | `service = "..."` | `env.BINDING.fetch()` |
| `queues.producers` | `queue = "..."` | `env.BINDING.send()` |
| `.env` file | `fromEnvironment = "NAME"` | `env.NAME` |

---

## Cap'n Proto Config

The generated config at `config.<port>.capnp` follows this structure:

```capnp
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "my-worker", worker = .myWorkerWorker),
  ],
  sockets = [
    ( name    = "http",
      address = "*:8080",
      http    = (),
      service = "my-worker"
    ),
  ]
);

const myWorkerWorker :Workerd.Worker = (
  modules = [ ( name = "index.js", esModule = embed "index.js" ) ],
  compatibilityDate = "2024-09-23",
  bindings = [
    ( name = "GREETING", text = "Hello!" ),
    ( name = "COUNTER", durableObjectNamespace = ( className = "Counter" ) ),
    ( name = "SECRET_KEY", fromEnvironment = "SECRET_KEY" ),
  ],
  durableObjectNamespaces = [
    ( className = "Counter", uniqueKey = "Counter-key" )
  ],
  durableObjectStorage = (inMemory = void)
);
```

Key points:
- `services` lists all workers in the group (main + service binding targets)
- `sockets` binds HTTP to the specified port
- `modules` embeds the worker source (esModule or serviceWorkerScript)
- Bindings use Cap'n Proto union tags for each type
- DO namespaces are on the Worker, not Config

---

## Environment Variables (.env)

Create a `.env` file in your project root:

```bash
SECRET_KEY=sk-abc123
API_URL=https://api.example.com
DEBUG=false
```

The CLI copies this to the server at `/etc/workerd/workers/<name>/.env`.

Format requirements (strict):
- `KEY=VALUE` — no spaces around `=`
- One variable per line
- No trailing whitespace
- No quotes around values (they'll be included literally)

The `workerd-start` script sources it via `set -a; source .env; set +a` before launching workerd.

---

## manifest.json (Server-Side)

The server-side `workerd-gen-config` script reads `manifest.json` from `/etc/workerd/workers/<name>/manifest.json`. This is used by:
- `workerd-scale up/down`
- `workerd-gen-config` directly
- Git push deploy hooks

```json
{
  "name": "my-worker",
  "entrypoint": "index.js",
  "compatibilityDate": "2024-09-23",
  "moduleType": "esm",
  "env": ["SECRET_KEY", "API_URL"],
  "bindings": [
    { "type": "service", "name": "AUTH", "service": "auth-worker" },
    { "type": "durableObjectNamespace", "name": "COUNTER", "className": "Counter" }
  ],
  "durableObjects": [
    { "className": "Counter", "uniqueKey": "counter-ns-v1" }
  ]
}
```

**Note**: The CLI (`werkerd deploy`) generates Cap'n Proto directly from `wrangler.jsonc` and does not require `manifest.json`. However, it now creates `manifest.json` on the server automatically to enable `workerd-scale` support. Only server-side scripts (`workerd-gen-config`, `workerd-scale`) need it.

---

## Systemd Unit Template

`/etc/systemd/system/workerd@.service`:

```ini
[Unit]
Description=workerd %i

[Service]
Type=exec
ExecStart=/usr/local/bin/workerd-start %i
Restart=always
RestartSec=1
User=workerd
Group=workerd
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/etc/workerd /var/lib/workerd
StandardOutput=journal
StandardError=journal
SyslogIdentifier=workerd-%i

[Install]
WantedBy=multi-user.target
```

The `%i` specifier carries the instance name (e.g., `my-worker:8080`), which `workerd-start` splits into `WORKER` and `PORT`.

Socket units are created per-instance by `workerd-scale`:

```ini
[Unit]
Description=Socket for workerd my-worker:8080

[Socket]
ListenStream=0.0.0.0:8080
NoDelay=true
Service=workerd@my-worker:8080.service

[Install]
WantedBy=sockets.target
```

---

## Binding Types Summary

| Type | wrangler.jsonc | Cap'n Proto | Notes |
|------|---------------|-------------|-------|
| Text | `vars` | `text = "..."` | Static, embedded in config |
| Env var | `.env` file | `fromEnvironment` | Runtime, from .env |
| KV | `kv_namespaces` | `kvNamespace` | Needs backend |
| R2 | `r2_buckets` | `r2Bucket` | Needs backend |
| D1 | `d1_databases` | wrapped | Needs backend |
| DO | `durable_objects` | `durableObjectNamespace` | In-memory by default |
| Service | `services` | `service` | In-process HTTP |
| Queue | `queues.producers` | `queue` | Needs queue worker |
| WASM | — | `wasmModule` | From .wasm file |
| Crypto | — | `cryptoKey` | Named key |
| Hyperdrive | — | `hyperdrive` | PostgreSQL/MySQL proxy |
| Analytics | — | `analyticsEngine` | Writes to analytics |
