# Self-Hosted Cloudflare Workers Platform — Agent Handoff Document

## Purpose

Build a self-hosted runtime equivalent to Cloudflare Workers using `workerd` (the open-source
runtime that powers Cloudflare Workers). This document is a complete specification: architecture
decisions, known facts, known unknowns, file layouts, and every component that needs to be built.

---

## What We Are Building

A production server that:

- Runs multiple Workers (JS/Wasm isolates) on a single machine
- Scales specific workers independently by adding more isolates of that worker
- Accepts deployments via `git push` (wrangler builds locally, pushes the output)
- Routes requests to the correct worker by hostname (custom domains per worker)
- Manages everything through systemd and Caddy — no containers, no orchestrators
- Gives workers custom domain routing via Caddy

The goal is parity with Cloudflare Workers DX for self-hosted code. We are not building
a multi-tenant hosting platform — this is for running your own workers on your own server.

---

## Verified Facts About workerd (Do Not Guess At These)

These were confirmed from the official Cloudflare blog post, GitHub discussions with core
maintainers, and Cloudflare Workers documentation.

### Isolate Model

- workerd is **single-threaded per process**. One event loop. Requests to the same worker
  within one process are handled concurrently (async/await) but not in parallel.
- Each worker in a config runs as a **separate V8 isolate** within the process.
- All built-in APIs (fetch, Request, Response, crypto, etc.) are implemented in **native C++**
  and are **shared across all isolates** in a process. You do not pay for them per isolate.
- Isolates themselves are cheap — the process is the expensive unit, not the isolate count.

### The Unit of Scaling

- To get more **parallel throughput** for a worker, you need **more isolates of that worker
  running in parallel**.
- Since workerd gives you exactly one isolate per worker per process, more isolates = more
  processes containing that worker.
- **The isolate is the unit of scaling. A process is a container for a set of isolates.**

### V8 Pointer Cage — Hard Limit

- V8 places all isolates in a process into a single **4GB pointer cage** by default.
- This caps how many isolates (workers) you can pack into one process before hitting memory
  pressure. Cloudflare's production runtime uses a separate pointer cage per isolate, but that
  is an **unsupported V8 configuration** that cannot be in open-source workerd.
- **Practical implication**: Do not put hundreds of workers into one process. For normal use
  (tens of workers), this is not a concern. For large deployments, spread workers across
  multiple processes.

### Service Bindings

- When Worker A calls Worker B via a service binding, the call is a **same-thread function
  call with zero network overhead**. This only works if both workers are in the **same process**.
- Workers that have service binding relationships with each other **must share a process**.
- This is workerd's "nanoservices" model and is a core architectural feature.

### LRU Eviction — Intentionally Absent

- workerd does **not** implement LRU isolate eviction. This was deliberately kept out of the
  open-source release (the maintainer confirmed this in GitHub discussions). It exists in
  Cloudflare's internal runtime but will not be contributed to workerd.
- Implication: all configured workers stay loaded in memory. Design your process groupings
  accordingly.

### Zero-Downtime on Restart — Socket Activation

This is not optional. Without it, every deploy causes dropped connections on any instance
being restarted — including single-instance workers with no pool to absorb the gap.

How it works: systemd holds the listening socket fd via a separate socket unit that stays
alive across service restarts. When the workerd service restarts, the socket unit keeps the
port open. The kernel queues incoming connections during the gap. The new process starts,
inherits the fd via `LISTEN_FDS` / `--socket-fd http=3`, and drains the queue. No
connection is refused. In-flight requests on the dying process get a SIGTERM grace window.

Architecture: the socket unit and service unit are separate. The socket unit has
`Service=workerd@worker:port.service` to tie them together. When you restart only the
service, the socket unit stays alive and the listening fd is preserved.

**Verify this actually works as the very first thing** — it is the foundation of the entire
deploy story. Confirm that `workerd --socket-fd http=3` correctly inherits a socket fd from
systemd before building anything else.

---

## Architecture

```
                          Internet
                             │
                          Caddy
                    (TLS termination,
                   hostname routing,
                   load balancing)
                        │        │
           ┌────────────┘        └────────────┐
           │                                  │
    api.domain.com                    app.domain.com
           │                                  │
    api worker pool               app worker pool
   ┌───────┴────────┐                    │
   │       │        │             workerd@app:9000
   │       │        │             [app isolate]
workerd@ workerd@ workerd@
api:8080 api:8081 api:8082
[api]    [api]    [api]
[auth]   [auth]   [auth]   ← auth co-located because api→auth service binding
```

### Key Design Decisions

**Per-worker process pools, not shared pools.**
Each worker (or group of workers connected by service bindings) gets its own pool of workerd
processes. Scale api by adding processes to the api pool. This does not affect app or auth.

**Caddy is not an abstraction layer — it is doing TLS.**
TLS termination has to happen somewhere. Caddy does it well, handles certificate renewal
automatically, and supports wildcard domains. It is one process doing one job.

**systemd manages all process lifecycle.**
No supervisor, no Docker, no k8s. systemd template units for services give you named,
parameterized instances that start on boot, restart on crash, and integrate with journald
for logs. Individual (non-template) socket units hold the listening ports and survive
service restarts for zero-downtime deploys.

---

## File System Layout

```
/etc/workerd/
  workers/
    api/
      config.capnp              ← workerd config for this worker group
      worker.js                 ← deployed bundle (written by git hook)
      manifest.json             ← worker group definition (see Manifest section)
      ports                     ← newline-separated list of active ports for this worker
                                    e.g: 8080\n8081\n8082
    app/
      config.capnp
      worker.js
      manifest.json
      ports                     ← 9000
    auth/
      config.capnp              ← NOTE: auth may not need its own pool if only
      worker.js                          called via service binding from api.
      manifest.json                      See Service Binding Topology section.
      ports

/var/lib/workerd/
  workers/
    api/                        ← git working tree checkout target
    app/
    auth/

/var/git/
  api.git/                      ← bare git repos (deploy targets)
    hooks/
      post-receive
  app.git/
  auth.git/

/etc/systemd/system/
  workerd@.service              ← template service unit
  workerd-api-8080.socket       ← concrete socket units (one per instance, generated)
  workerd-api-8081.socket
  workerd-app-9000.socket

/etc/caddy/
  Caddyfile

/usr/local/bin/
  workerd-gen-config            ← generate Cap'n Proto config from manifest
  workerd-scale                 ← scale a worker pool up/down
  workerd-deploy-hook           ← called by git post-receive
  workerd-start                 ← wrapper script called by systemd service unit
```

---

## workerd Configuration (Cap'n Proto)

Each worker group has its own `config.capnp`. This is the format workerd requires.
It is not bash-templated — it is generated by a Node.js or Python script that writes
valid Cap'n Proto text format.

### Single Worker (no service bindings)

```capnp
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "app", worker = .appWorker),
  ],
  sockets = [
    ( name    = "http",
      address = "*:${PORT}",
      http    = (),
      service = "app"
    ),
  ]
);

const appWorker :Workerd.Worker = (
  serviceWorkerScript = embed "/etc/workerd/workers/app/worker.js",
  compatibilityDate   = "2024-09-23",
);
```

### Worker Group With Service Bindings (api calls auth)

Both services are defined in the **same config file** so they run in the same process
and the service binding is a zero-cost intra-process call.

```capnp
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "api",  worker = .apiWorker),
    (name = "auth", worker = .authWorker),
  ],
  sockets = [
    ( name    = "http",
      address = "*:${PORT}",
      http    = (),
      service = "api"
    ),
  ]
);

const apiWorker :Workerd.Worker = (
  serviceWorkerScript = embed "/etc/workerd/workers/api/worker.js",
  compatibilityDate   = "2024-09-23",
  bindings = [
    ( name = "AUTH", service = "auth" ),
  ],
);

const authWorker :Workerd.Worker = (
  serviceWorkerScript = embed "/etc/workerd/workers/auth/worker.js",
  compatibilityDate   = "2024-09-23",
);
```

In `api/worker.js`, calling auth:
```js
const response = await env.AUTH.fetch(request);
```
This is a function call, not an HTTP request. Zero latency.

### Config Generation Script

The `${PORT}` in the config must be substituted per process instance. This is done by the
config generator, not by bash. Write a script at `/usr/local/bin/workerd-gen-config`:

```js
#!/usr/bin/env node
// Usage: workerd-gen-config <worker-name> <port>
// Reads /etc/workerd/workers/<name>/manifest.json
// Writes /etc/workerd/workers/<name>/config.<port>.capnp

const fs   = require("fs");
const path = require("path");

const [,, workerName, port] = process.argv;
const base = `/etc/workerd/workers/${workerName}`;
const manifest = require(`${base}/manifest.json`);
// manifest.json structure — see Manifest File section below:
// {
//   "name": "api",
//   "entrypoint": "worker.js",
//   "compatibilityDate": "2024-09-23",
//   "group": ["api", "auth"],
//   "bindings": [{ "name": "AUTH", "service": "auth" }]
// }

function generateConfig(manifest, port) {
  const group      = manifest.group || [manifest.name];
  const entrypoint = manifest.entrypoint || "worker.js";
  const compatDate = manifest.compatibilityDate || "2024-09-23";

  const services = group.map(name =>
    `    (name = "${name}", worker = .${name}Worker),`
  ).join("\n");

  const workers = group.map(name => {
    const workerEntry = (name === manifest.name)
      ? entrypoint
      : "worker.js"; // co-located workers use their own worker.js
    return (
`const ${name}Worker :Workerd.Worker = (
  serviceWorkerScript = embed "${base}/../${name}/${workerEntry}",
  compatibilityDate   = "${compatDate}",
  bindings = [${(name === manifest.name ? (manifest.bindings || []).map(b =>
    `\n    ( name = "${b.name}", service = "${b.service}" ),`
  ).join("") + "\n  " : "")}],
);`
    );
  }).join("\n\n");

  const socketService = manifest.socket || manifest.name;

  return (
`using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
${services}
  ],
  sockets = [
    ( name    = "http",
      address = "*:${port}",
      http    = (),
      service = "${socketService}"
    ),
  ]
);

${workers}
`);
}

const config = generateConfig(manifest, port);
const outPath = `${base}/config.${port}.capnp`;
fs.writeFileSync(outPath, config);
console.log(`Wrote ${outPath}`);
```

Each running instance gets its own `config.<port>.capnp`. The systemd service unit points to it.

**Important**: Cap'n Proto text format is strict. Do not attempt to template it with sed/bash.
Write a proper generator in JS or Python. Validate syntax before deploying using the workerd
CLI (check `workerd --help` for available validation subcommands; recent versions may support
`workerd compile` or validate as part of `workerd serve`).

---

## Systemd Units

Socket activation uses two units: a concrete (non-template) socket unit per instance that
holds the listening fd, and a template service unit that inherits it. The socket unit
survives service restarts — this is what gives us zero-downtime deploys.

### Socket Unit (concrete, generated per instance)

Because systemd specifiers cannot cleanly extract a port number from a `worker:port` instance
name, socket units are generated as concrete files (not templates) by the `workerd-scale`
script. One file per worker:port pair.

```ini
# /etc/systemd/system/workerd-api-8080.socket
# Generated by: workerd-scale up api 8080
# Name convention: workerd-<worker>-<port>.socket
[Unit]
Description=Socket for workerd api:8080

[Socket]
ListenStream=0.0.0.0:8080
NoDelay=true
Service=workerd@api:8080.service

[Install]
WantedBy=sockets.target
```

Key points:
- `Service=workerd@api:8080.service` — ties this socket to the template service instance.
  When a connection arrives, systemd starts the service if it isn't already running.
- `sockets.target` — socket units are wanted by this target so they start at boot.
- The port is hardcoded in the file name and `ListenStream`. No specifier tricks needed.
- The worker name and port are also encoded in the filename for discoverability.

### Template Service Unit

```ini
# /etc/systemd/system/workerd@.service
# Instance name: <workername>:<port>  e.g. workerd@api:8080.service
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

### Wrapper Script: `/usr/local/bin/workerd-start`

All the shell logic lives in a standalone script — testable, debuggable, and keeps the
unit file clean. No inline bash, no fragile escape sequences.

```bash
#!/bin/bash
# /usr/local/bin/workerd-start
# Called by workerd@.service with %i as argument (e.g., "api:8080")
set -euo pipefail

INSTANCE="$1"                            # e.g. "api:8080"
WORKER="${INSTANCE%%:*}"                 # e.g. "api"
PORT="${INSTANCE##*:}"                   # e.g. "8080"

CONFIG="/etc/workerd/workers/${WORKER}/config.${PORT}.capnp"

# Generate the config if it doesn't exist (first boot, or after cleanup)
if [ ! -f "$CONFIG" ]; then
    /usr/local/bin/workerd-gen-config "$WORKER" "$PORT"
fi

exec /usr/bin/workerd serve "$CONFIG" --socket-fd http=3
```

### Starting an Instance

Enable the socket unit. It starts at boot and activates the service on first connection
(or immediately if you also enable the service):

```bash
systemctl enable --now workerd-api-8080.socket
# Optionally also enable the service so it starts immediately without waiting
# for the first connection:
systemctl enable --now workerd@api:8080.service
```

### Rolling Restart During Deploy

Restart only the **service**, not the socket. The socket unit stays alive, the port stays
open, the kernel queues connections. Every restart is zero-downtime individually.

```bash
# Restart all instances of a worker — connections queue, never drop
while IFS= read -r port; do
    systemctl restart "workerd@${WORKER}:${port}"
done < "$PORTS_FILE"
# No sleep needed for correctness (socket unit handles the gap);
# keep a small sleep for log readability if preferred
```

---

## Caddy Configuration

### Per-Worker Upstream Blocks

```caddy
# /etc/caddy/Caddyfile

# api worker — 3 instances
api.yourdomain.com {
    reverse_proxy localhost:8080 localhost:8081 localhost:8082 {
        lb_policy       least_conn
        health_uri      /healthz
        health_interval 10s
        health_timeout  3s
    }
    tls your@email.com
}

# app worker — 1 instance
app.yourdomain.com {
    reverse_proxy localhost:9000 {
        health_uri      /healthz
        health_interval 10s
    }
    tls your@email.com
}

# Wildcard workers subdomain — routes to a dispatcher
*.workers.yourdomain.com {
    reverse_proxy localhost:7000 {
        lb_policy least_conn
    }
    tls {
        dns cloudflare {env.CF_DNS_API_TOKEN}
    }
}
```

### Managing Upstreams

The upstream list for each worker is generated from the worker's `ports` file. There are
two approaches:

**Option A — Generated Caddyfile (recommended for simplicity):**
The entire Caddyfile is generated by `/usr/local/bin/workerd-gen-caddyfile`, which reads
all `ports` files and produces the complete Caddyfile. Reload with:
```bash
caddy reload --config /etc/caddy/Caddyfile
```
Caddy reload is hot — no connections dropped, no restart.

**Option B — Caddy Admin API (preferred for production):**
Caddy's JSON admin API at `:2019` supports live upstream changes without file writes:
```bash
# Example: add or reconfigure upstreams via the API
curl -X POST http://localhost:2019/config/apps/http/servers/srv0/routes \
  -H "Content-Type: application/json" \
  -d '{...}'
```
See https://caddyserver.com/docs/api for full API documentation. Use this approach if
you need to modify upstreams at runtime without touching the Caddyfile.

**For the initial build, use Option A** (generated Caddyfile). It is simpler and easier
to debug. Migrate to Option B later if needed.

---

## Scaling Operations

### `workerd-scale` Script

```bash
#!/bin/bash
# /usr/local/bin/workerd-scale
# Usage:
#   workerd-scale up   <worker> <port>   — add an instance
#   workerd-scale down <worker> <port>   — remove an instance
#   workerd-scale list <worker>          — show running instances

set -euo pipefail

ACTION=$1
WORKER=$2
PORT=${3:-}
PORTS_FILE="/etc/workerd/workers/$WORKER/ports"
SOCKET_UNIT="workerd-${WORKER}-${PORT}.socket"
SERVICE_UNIT="workerd@${WORKER}:${PORT}.service"

die() { echo "ERROR: $*" >&2; exit 1; }

case $ACTION in
  up)
    [ -z "$PORT" ] && die "port required"

    # Check port is not already in use by another worker
    if ss -tlnp | grep -q ":${PORT}\b"; then
        die "Port $PORT is already in use"
    fi

    # Add to ports file if not already there
    grep -qxF "$PORT" "$PORTS_FILE" 2>/dev/null || echo "$PORT" >> "$PORTS_FILE"

    # Generate config for this instance
    /usr/local/bin/workerd-gen-config "$WORKER" "$PORT"

    # Create socket unit file
    cat > "/etc/systemd/system/${SOCKET_UNIT}" << SOCKETEOF
[Unit]
Description=Socket for workerd ${WORKER}:${PORT}

[Socket]
ListenStream=0.0.0.0:${PORT}
NoDelay=true
Service=${SERVICE_UNIT}

[Install]
WantedBy=sockets.target
SOCKETEOF

    systemctl daemon-reload
    systemctl enable --now "$SOCKET_UNIT"

    # Regenerate Caddyfile
    /usr/local/bin/workerd-gen-caddyfile
    caddy reload --config /etc/caddy/Caddyfile

    echo "✔  ${SERVICE_UNIT} started on port ${PORT}"
    ;;

  down)
    [ -z "$PORT" ] && die "port required"

    systemctl stop    "$SERVICE_UNIT" 2>/dev/null || true
    systemctl disable "$SERVICE_UNIT" 2>/dev/null || true
    systemctl stop    "$SOCKET_UNIT"  2>/dev/null || true
    systemctl disable "$SOCKET_UNIT"  2>/dev/null || true
    rm -f "/etc/systemd/system/${SOCKET_UNIT}"
    systemctl daemon-reload

    # Remove from ports file
    sed -i "/^${PORT}$/d" "$PORTS_FILE"

    # Regenerate Caddyfile
    /usr/local/bin/workerd-gen-caddyfile
    caddy reload --config /etc/caddy/Caddyfile

    echo "✔  ${SERVICE_UNIT} stopped"
    ;;

  list)
    echo "Active instances for $WORKER:"
    systemctl list-units "workerd@${WORKER}:*" --no-legend --state=active 2>/dev/null || true
    echo ""
    echo "Registered ports:"
    cat "$PORTS_FILE" 2>/dev/null || echo "  (no ports file)"
    ;;
esac
```

### `workerd-gen-caddyfile` Script

```bash
#!/bin/bash
# /usr/local/bin/workerd-gen-caddyfile
# Generates /etc/caddy/Caddyfile from all workers' ports files
# Combined with any manual entries in /etc/caddy/Caddyfile.manual

set -euo pipefail

CADDYFILE="/etc/caddy/Caddyfile"
WORKERS_DIR="/etc/workerd/workers"

cat > "$CADDYFILE" << 'HEADER'
# Generated by workerd-gen-caddyfile — do not edit manually
# Add manual entries to /etc/caddy/Caddyfile.manual

HEADER

# Dynamically generate upstream blocks for each worker
for worker_dir in "$WORKERS_DIR"/*/; do
    worker=$(basename "$worker_dir")
    ports_file="${worker_dir}/ports"
    [ -f "$ports_file" ] || continue

    ports=$(tr '\n' ' ' < "$ports_file" | sed 's/ $//')
    [ -z "$ports" ] && continue

    cat << BLOCK

# BEGIN workerd:${worker}
${worker}.yourdomain.com {
    reverse_proxy ${ports// / } {
        lb_policy       least_conn
        health_uri      /healthz
        health_interval 10s
        health_timeout  3s
    }
    tls your@email.com
}
# END workerd:${worker}
BLOCK
done

# Append manual entries if present
if [ -f /etc/caddy/Caddyfile.manual ]; then
    echo "" >> "$CADDYFILE"
    cat /etc/caddy/Caddyfile.manual >> "$CADDYFILE"
fi

echo "Caddyfile regenerated"
```

---

## Deployment Pipeline

### Overview

```
Developer machine                        Server
─────────────────                        ──────
wrangler deploy --dry-run --outdir dist
git -C dist add worker.js
git -C dist commit -m "deploy"
git -C dist push deploy main ──────────► bare repo receives push
                                         post-receive hook fires
                                           checkout worker.js
                                           rolling restart of pool
                                         ✔ deployed
```

### Git Server Setup (per worker)

```bash
# On server, as root or workerd user
mkdir -p /var/git/api.git
cd /var/git/api.git
git init --bare

# Set ownership
chown -R workerd:workerd /var/git/api.git
```

### Developer Side (per worker, one-time setup)

```bash
# In the worker project directory
git remote add deploy ssh://deploy@yourserver:/var/git/api.git
```

### Deploy Script (developer runs this)

```bash
#!/bin/bash
# deploy.sh — run from worker project root
set -euo pipefail

WORKER=${1:-$(basename "$(pwd)")}

echo "→ Building $WORKER..."
wrangler deploy --dry-run --outdir dist

echo "→ Pushing to server..."
cd dist

# Git <2.28 does not support -b; use two-step init for compatibility
git init
git checkout -b main 2>/dev/null || git checkout main

git add worker.js
git commit -m "deploy $(date -u +%Y%m%dT%H%M%SZ)"
git remote add deploy "ssh://deploy@yourserver:/var/git/${WORKER}.git" 2>/dev/null || true
git push deploy main --force

echo "✔ Deploy triggered"
```

> **Note**: Removed `--allow-empty` from the commit command. If you want a deploy to proceed
> even when worker.js hasn't changed, add it back — but be aware it causes unnecessary
> rolling restarts. A better approach is to compare the pushed worker.js against the
> existing one on the server and skip the restart if unchanged.

### Post-Receive Hook

```bash
#!/bin/bash
# /var/git/api.git/hooks/post-receive
# Receives: <oldrev> <newrev> <refname> on stdin

set -euo pipefail

WORKER="api"   # hardcoded per repo — each worker has its own bare repo
GIT_DIR="/var/git/${WORKER}.git"
DEPLOY_DIR="/etc/workerd/workers/${WORKER}"
PORTS_FILE="${DEPLOY_DIR}/ports"

while read oldrev newrev refname; do
    [ "$refname" = "refs/heads/main" ] || continue

    echo "→ Checking out worker.js..."
    git --work-tree="$DEPLOY_DIR" --git-dir="$GIT_DIR" checkout -f main -- worker.js

    echo "→ Regenerating configs..."
    while IFS= read -r port; do
        /usr/local/bin/workerd-gen-config "$WORKER" "$port"
        echo "  config.${port}.capnp written"
    done < "$PORTS_FILE"

    echo "→ Validating config..."
    # Validate one instance config — if it fails, abort before touching anything
    FIRST_PORT=$(head -1 "$PORTS_FILE")
    # NOTE: verify the exact validation command with `workerd --help`.
    # If `workerd compile` does not exist, use an alternative validation approach.
    workerd compile "${DEPLOY_DIR}/config.${FIRST_PORT}.capnp" 2>&1 \
        || { echo "✗ Config validation failed. Deploy aborted."; exit 1; }

    echo "→ Rolling restart..."
    while IFS= read -r port; do
        systemctl restart "workerd@${WORKER}:${port}"
        echo "  restarted :${port}"
        sleep 0.5
    done < "$PORTS_FILE"

    echo "✔ Deployed $WORKER ($(wc -l < "$PORTS_FILE") instances)"
done
```

Make executable: `chmod +x /var/git/api.git/hooks/post-receive`

### Why Deploy is Zero-Downtime

Socket activation means each restart — whether a single-instance worker or a pool — never
drops a connection. The socket unit stays alive (we only restart the service), the kernel
queues while the process restarts. There is no dependency on pool size for correctness.

---

## Service Binding Topology

This is the most important architectural decision per deployment. It determines which workers
share a config file (and therefore a process).

### Rules

1. If Worker A has a service binding to Worker B, they **must** be in the same config file.
2. Workers in the same config file scale together — one process contains all of them.
3. If B also receives direct external traffic (not just calls from A), B can appear in
   multiple config files: once in A's group (for the service binding), and once alone
   (for its own traffic). These are separate isolates — they don't share state.

### Example Topology

```
api  →  auth   (service binding: api calls auth)
api  →  cache  (service binding: api calls cache)
app            (standalone, no bindings)
auth           (also takes direct traffic from mobile clients)
```

Process groups:
```
Group 1: [api + auth + cache]  — api's pool, scaled for api's traffic
Group 2: [auth]                — auth's own pool, scaled for direct auth traffic
Group 3: [app]                 — app's pool
```

auth runs in two groups. Each group instance has independent isolates. This is correct and
expected — auth is handling more total load because it serves two traffic sources.

### Manifest File

Each worker directory has a `manifest.json` that the config generator reads. This file
defines everything the config generator needs to produce valid Cap'n Proto configuration.

```json
{
  "name": "api",
  "entrypoint": "worker.js",
  "socket": "api",
  "compatibilityDate": "2024-09-23",
  "group": ["api", "auth", "cache"],
  "bindings": [
    { "name": "AUTH",  "service": "auth"  },
    { "name": "CACHE", "service": "cache" }
  ]
}
```

Fields:
- `name` — this worker's service name in the Cap'n Proto config
- `entrypoint` — the JS file to embed (default: `"worker.js"`)
- `socket` — which service in the group receives external HTTP traffic (default: same as `name`)
- `compatibilityDate` — Cloudflare Workers compatibility date
- `group` — all workers that must run in this process (for service binding relationships)
- `bindings` — service bindings; each `service` value must be a member of `group`

The `group` array tells the config generator which other workers' `worker.js` files to embed
into this process's config. All named workers' bundles must be present on the server.

> **Deploy coupling note**: When a worker group has multiple members (e.g., `["api","auth"]`),
> deploying just `api`'s `worker.js` does not update `auth`'s code in the same process.
> Either (a) deploy all group members together, or (b) ensure outdated group members are
> compatible with the newly deployed worker. For initial implementation, keep groups small
> and deploy group members in lockstep.

---

## Server Setup (Bootstrap)

These are the one-time steps to set up a fresh server.

### 1. Install dependencies

```bash
# Node.js (required for config generator and workerd npm package)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
```

### 2. Install workerd

```bash
# workerd is distributed via npm. Install globally:
npm install -g workerd

# Verify:
which workerd
workerd --help
```

The binary installs to npm's global bin directory (typically `/usr/local/bin/workerd`
or `/usr/bin/workerd`). If you need a specific path, symlink it:
```bash
ln -sf "$(which workerd)" /usr/bin/workerd
```

### 3. Install Caddy

```bash
# Official Caddy repo (Cloudsmith, not Cloudflare)
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
sudo chmod o+r /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

Reference: https://caddyserver.com/docs/install#debian-ubuntu-raspbian

### 4. Create workerd user

```bash
useradd -r -s /usr/sbin/nologin workerd
```

### 5. Create directories

```bash
mkdir -p /etc/workerd/workers
mkdir -p /var/lib/workerd/workers
mkdir -p /var/git
chown -R workerd:workerd /etc/workerd /var/lib/workerd /var/git
```

### 6. Install systemd template unit

```bash
# Copy workerd@.service to /etc/systemd/system/
# (see Template Service Unit section above)
systemctl daemon-reload
```

### 7. Install management scripts

```bash
# workerd-gen-config, workerd-scale, workerd-gen-caddyfile,
# workerd-start, workerd-deploy-hook → /usr/local/bin/
chmod +x /usr/local/bin/workerd-*
```

### 8. Configure Caddy

```bash
# Generate initial Caddyfile
/usr/local/bin/workerd-gen-caddyfile
systemctl enable --now caddy
```

### 9. Allow deploy user to manage workerd units

```bash
cat > /etc/sudoers.d/workerd-deploy << 'EOF'
deploy ALL=(root) NOPASSWD: /bin/systemctl restart workerd@*
deploy ALL=(root) NOPASSWD: /bin/systemctl start workerd@*
deploy ALL=(root) NOPASSWD: /bin/systemctl stop workerd@*
deploy ALL=(root) NOPASSWD: /bin/systemctl enable workerd@*
deploy ALL=(root) NOPASSWD: /bin/systemctl disable workerd@*
deploy ALL=(root) NOPASSWD: /bin/systemctl daemon-reload
EOF
chmod 440 /etc/sudoers.d/workerd-deploy
```

### 10. SSH access for git push

```bash
# Add developer public keys to /home/deploy/.ssh/authorized_keys
```

---

## Healthcheck Endpoint

workerd does not have a built-in `/healthz`. Add it to each worker that receives external
traffic:

```js
export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (url.pathname === '/healthz') {
            return new Response('ok', { status: 200 });
        }

        // ... actual worker logic
    }
}
```

Caddy's `health_uri /healthz` uses this to detect when an instance is ready after restart
and to pull it from rotation if it goes unhealthy.

> **Alternative**: For workers that must not include health-check logic in application code,
> create a thin proxy worker in the same process group that handles `/healthz` and forwards
> everything else to the app worker. This keeps health checks separate from business logic.

---

## Custom Domains

For a new worker that needs its own domain:

1. Point the domain's DNS A record to your server IP
2. Add a block to the Caddyfile (or `Caddyfile.manual`):
   ```caddy
   mynewapp.com {
       reverse_proxy localhost:9100 {
           health_uri /healthz
       }
   }
   ```
3. Reload Caddy: `caddy reload --config /etc/caddy/Caddyfile`
4. Caddy handles TLS certificate issuance automatically via ACME/Let's Encrypt

For wildcard domains (e.g., `*.workers.yourdomain.com`), you need DNS challenge TLS.
Caddy supports this with DNS provider plugins. See Caddy docs for your DNS provider.

---

## Secrets & Environment Variables

Cloudflare Workers access secrets via `env.SECRET_NAME` in the fetch handler. In a
self-hosted deployment, secrets can be provided through:

**Option A — EnvironmentFile per worker (recommended):**
Add to the service unit template or wrapper script:
```bash
# In workerd-start, before exec:
ENVFILE="/etc/workerd/workers/${WORKER}/.env"
[ -f "$ENVFILE" ] && set -a && source "$ENVFILE" && set +a
```
Then access in worker code via `env.SECRET_NAME` (workerd passes environment variables
through as bindings when configured in Cap'n Proto).

**Option B — Cap'n Proto text bindings:**
Define secrets directly in the config (less secure — visible in config files):
```capnp
bindings = [
    ( name = "API_KEY", text = "sk-xxxx" ),
]
```

**For production**, store per-worker `.env` files with restrictive permissions (`chmod 600`)
and use Option A.

---

## Observability

### Logs

All worker output goes to journald. View logs with:
```bash
# All logs for a specific instance
journalctl -u workerd@api:8080

# Follow (tail -f equivalent)
journalctl -u workerd@api:8080 -f

# All workers on the system
journalctl -u 'workerd@*'

# Since last boot
journalctl -u workerd@api:8080 -b
```

### Metrics

workerd does not expose a built-in metrics endpoint. For basic observability:
- Caddy's built-in metrics (enable with `metrics` directive)
- System-level metrics from journald (`journalctl` + `grep` for error patterns)
- Consider adding a `/metrics` endpoint to workers for Prometheus scraping

---

## Known Limitations vs Cloudflare

| Feature | Cloudflare | Self-Hosted |
|---------|------------|-------------|
| Global edge distribution | Hundreds of PoPs | Your server location |
| Auto scaling | Automatic | Manual: `workerd-scale up worker port` |
| Per-request isolate eviction | Built-in | Not available in open-source workerd |
| Distributed Durable Objects | Yes | Local disk only, single machine |
| Worker-to-Worker across regions | Yes | Same machine only |
| 0ms cold starts guaranteed | Yes | Effectively yes (isolates stay loaded) |
| Binding: KV | Cloudflare KV | Implement with Redis or similar |
| Binding: D1 | Cloudflare D1 | Implement with SQLite |
| Binding: R2 | Cloudflare R2 | Implement with MinIO or local fs |
| Binding: Queues | Cloudflare Queues | Implement with Redis streams or similar |

Bindings (KV, D1, R2, Queues) are out of scope for this document but can be wired as
env var fetch endpoints or native bindings in the Cap'n Proto config. workerd supports
defining custom bindings that point to arbitrary services.

---

## Open Questions (Research Before Implementing)

These are things that could not be confirmed with certainty and need verification:

1. **workerd `--socket-fd` with systemd socket activation**: The flag exists (referenced
   in workerd source discussions) but the exact interaction with `sd_listen_fds` needs
   to be tested. Verify that socket activation works before relying on it for
   zero-downtime. Test with:
   ```bash
   # Start a socket unit pointing to a test service
   # systemd sets LISTEN_FDS=1, LISTEN_PID=...
   # workerd should receive the socket on fd 3
   ```

2. **Cap'n Proto text format validation**: Verify that `workerd compile config.capnp`
   exists and validates syntax without starting a server. If not available, check
   `workerd --help` for alternatives (e.g., `workerd serve --validate`).

3. **Cap'n Proto text format for port substitution**: The config generator must write valid
   Cap'n Proto text format. The port appears in the `address` field. Confirm that
   `address = "*:8080"` is the correct syntax and that embedding a generated port value
   works as expected.

4. **Memory per process with one worker**: The blog post confirms that workerd amortizes
   native API overhead across all isolates. What is the baseline RSS for a workerd process
   with a single trivial worker? Measure with:
   ```bash
   systemd-run --scope workerd serve single-worker.capnp
   cat /proc/$(pgrep workerd)/status | grep VmRSS
   ```
   This determines how many single-worker processes you can reasonably run on a given machine.

5. **workerd npm package path**: `npm install -g workerd` installs the binary to npm's
   global prefix. Verify the binary path and that it's accessible to the `workerd` system
   user. If npm's global bin is not in the service's PATH, use an absolute path or symlink.

---

## Implementation Order

Build in this order. Each step is independently testable.

1. Install workerd, verify `workerd serve` works with the hello-world config from the README
2. **Verify socket activation**: manually test that `workerd --socket-fd http=3` correctly
   inherits a socket fd from systemd. This must work before anything else is built.
3. Write `workerd-gen-config` — generate valid Cap'n Proto, validate with the workerd CLI
4. Write and test the systemd template service unit + concrete socket unit with a single worker
5. Write `workerd-start` wrapper script
6. Set up Caddy, verify it proxies to the workerd instance
7. Set up a bare git repo and post-receive hook, verify a push deploys and restarts
8. Test zero-downtime: push while keeping a long-poll open, verify it completes without dropping
9. Write `workerd-scale`, test scaling up and down, verify socket units are created/removed
10. Write `workerd-gen-caddyfile`, verify Caddyfile regeneration
11. Add a second worker with a service binding, verify same-process intra-call works
12. Set up a second worker pool (different worker, different ports), verify isolation
13. Custom domain TLS with Caddy
14. Healthcheck endpoint and Caddy health polling
15. Secrets via EnvironmentFile
16. Log inspection via journalctl

---

## References

- workerd README: https://github.com/cloudflare/workerd
- workerd.capnp (config format reference): https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.capnp
- Cloudflare blog (architectural decisions): https://blog.cloudflare.com/workerd-open-source-workers-runtime/
- GitHub Discussion #351 (pointer cage, LRU eviction): https://github.com/cloudflare/workerd/discussions/351
- Caddy reverse proxy docs: https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
- Caddy admin API: https://caddyserver.com/docs/api
- Caddy install (Debian/Ubuntu): https://caddyserver.com/docs/install#debian-ubuntu-raspbian
- systemd template units: https://www.freedesktop.org/software/systemd/man/systemd.unit.html#id-1.6.15
- systemd socket units: https://www.freedesktop.org/software/systemd/man/systemd.socket.html
- Cap'n Proto text format: https://capnproto.org/capnp-tool.html
