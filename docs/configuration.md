# Configuration Reference

## manifest.json

Every worker requires a `manifest.json` at `/etc/workerd/workers/<name>/manifest.json`. This file defines the worker's identity, dependencies, and bindings. The `workerd-gen-config` script reads it to produce a Cap'n Proto config.

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Worker name (used for directory paths, service names, git repo) |
| `entrypoint` | string | Path to the main worker file (relative to worker directory) |
| `compatibilityDate` | string | Cloudflare compatibility date in `YYYY-MM-DD` format |

### Optional Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `moduleType` | `"esm"` \| `"service-worker"` | auto-detected | Module system |
| `group` | string[] | `[name]` | Workers in the same process group (for service bindings) |
| `bindings` | Binding[] | `[]` | Bindings available to the worker |
| `env` | string[] | `[]` | Environment variable names to expose |
| `durableObjects` | DO[] | `[]` | Durable Object namespace definitions |
| `durableObjectStorage` | `"inMemory"` \| `"localDisk"` | `"inMemory"` | DO storage backend |
| `tailWorkers` | string[] | `[]` | Tail worker services |
| `disableInternet` | boolean | `false` | Block internet access from worker |
| `socket` | string | `name` | Service name to bind the socket to |

### Binding Object

Each binding has a `type` field and a `name` field. Additional fields depend on type.

```json
{ "type": "<type>", "name": "<name>", ... }
```

#### service
Service binding — allows calling another worker in the same group.
```json
{ "type": "service", "name": "AUTH", "service": "auth-worker" }
```
Worker code: `const resp = await env.AUTH.fetch("http://internal/...");`

#### durableObjectNamespace
Durable Object namespace binding — allows creating and calling DOs.
```json
{ "type": "durableObjectNamespace", "name": "COUNTER", "className": "Counter" }
```
Worker code: `const id = env.COUNTER.idFromName("my-counter");`

#### kvNamespace
KV storage binding.
```json
{ "type": "kvNamespace", "name": "STORE", "service": "kv-service" }
```

#### r2Bucket
R2 object storage binding.
```json
{ "type": "r2Bucket", "name": "FILES", "service": "r2-service" }
```

#### queue
Message queue binding.
```json
{ "type": "queue", "name": "TASKS", "service": "queue-service" }
```

#### fromEnvironment
Load from `.env` file. Automatically added for entries in the `env` array.
```json
{ "type": "fromEnvironment", "name": "SECRET_KEY" }
```

#### text
Static text binding.
```json
{ "type": "text", "name": "WELCOME_MSG", "text": "Hello World" }
```

#### json
Static JSON binding.
```json
{ "type": "json", "name": "CONFIG", "json": "{\"debug\": true}" }
```

#### data
Raw binary data from file.
```json
{ "type": "data", "name": "BLOB", "file": "data.bin" }
```

#### wasmModule
WebAssembly module from file.
```json
{ "type": "wasmModule", "name": "WASM", "file": "module.wasm" }
```

#### memoryCache
In-memory cache binding.
```json
{ "type": "memoryCache", "name": "CACHE", "id": "my-cache-v1" }
```

#### unsafeEval
Permits `eval()` and `new Function()` in the worker.
```json
{ "type": "unsafeEval", "name": "EVAL" }
```

#### hyperdrive
Database proxy binding (PostgreSQL/MySQL).
```json
{
  "type": "hyperdrive",
  "name": "DB",
  "designator": "prod-db",
  "database": "mydb",
  "user": "app",
  "password": "secret",
  "scheme": "postgres"
}
```

#### cryptoKey
Named crypto key binding.
```json
{ "type": "cryptoKey", "name": "SIGN_KEY", "algorithm": "Ed25519", "hex": "abcdef..." }
```
Also supports `jwk` instead of `hex`, or `file` for a raw key file.

#### analyticsEngine
Analytics engine binding.
```json
{ "type": "analyticsEngine", "name": "ANALYTICS", "service": "ae-service" }
```

### Durable Object Definition

Each entry in the `durableObjects` array:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `className` | string | Yes | Exported class name |
| `uniqueKey` | string | No | Stable unique key for the namespace |
| `ephemeral` | boolean | No | Use ephemeral storage (no persistence) |
| `preventEviction` | boolean | No | Keep DO in memory after idle |
| `enableSql` | boolean | No | Enable SQLite storage API |

Example:
```json
"durableObjects": [
  {
    "className": "Counter",
    "uniqueKey": "counter-ns-v1",
    "preventEviction": true,
    "enableSql": true
  },
  {
    "className": "ChatRoom",
    "ephemeral": true
  }
]
```

Note: The current workerd binary does not support `durableObjectNamespaces` at the Config level. The config generator handles this internally and uses Worker-level bindings only.

## Environment Variables (.env)

Create `/etc/workerd/workers/<name>/.env`:

```bash
SECRET_KEY=sk-abc123
API_URL=https://api.example.com
OTHER_VAR=foo
```

Only variables listed in the manifest's `env` array are exposed:

```json
{ "env": ["SECRET_KEY", "API_URL"] }
```

The `.env` file is sourced by `workerd-start` via `set -a; source .env; set +a` before workerd starts.

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
  modules = [ ( name = "worker.js", esModule = embed "worker.js" ) ],
  compatibilityDate   = "2024-09-23",
  bindings = [
    ( name = "SECRET_KEY", fromEnvironment = "SECRET_KEY" ),
    ( name = "COUNTER", durableObjectNamespace = ( className = "Counter" ) ),
  ],
);
```

Key points:
- `services` lists all workers in the group
- `sockets` binds HTTP to the specified port
- Worker definitions reference embedded source files
- Bindings use Cap'n Proto union tags for each type

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
```]]>