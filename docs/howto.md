# How-To Guide

## Getting Started
- [Server Bootstrap](#server-bootstrap) — Set up a new werkerd server from scratch
- [First Worker](#first-worker) — Deploy your first worker

## Workers
- [ES Modules](#es-modules) — Use modern ES module syntax
- [Service Worker Format](#service-worker-format) — Classic addEventListener format
- [Static Assets](#static-assets) — Serve HTML, CSS, JS files

## Features
- [Service Bindings](#service-bindings) — In-process RPC between workers
- [Durable Objects](#durable-objects) — Stateful serverless objects
- [KV Namespace](#kv-namespace) — Key-value storage
- [R2 Buckets](#r2-buckets) — Object storage
- [WebSockets](#websockets) — Real-time communication
- [Environment Variables](#environment-variables) — Secrets and config

## Operations
- [Scaling](#scaling) — Add/remove instances
- [Deploying](#deploying) — CLI or git push
- [Monitoring](#monitoring) — Logs, health checks, metrics

## Reference
- [wrangler.jsonc Schema](configuration.md#wrangler-jsonc-reference)
- [Cap'n Proto Config](configuration.md#capn-proto-config)
- [Systemd Units](architecture.md#layer-2-systemd-socket-activation)

---

## Server Bootstrap

From a fresh Ubuntu 22.04+ server:

```bash
# On your local machine
scp management-scripts/bootstrap.sh YOUR_USER@YOUR_SERVER:/tmp/
ssh YOUR_USER@YOUR_SERVER sudo bash /tmp/management-scripts/bootstrap.sh
```

The bootstrap script installs: Node.js 20.x, workerd, nginx, systemd units, management scripts, and creates the `workerd` system user.

## First Worker

```bash
# 1. Install the CLI
cd werkerd-cli && npm install && npm link

# 2. Create a worker (or use an existing Cloudflare Workers project)
cd ~/my-worker
werkerd deploy --port 8080

# 3. Verify
curl http://YOUR_SERVER:8080/
# Or via nginx: curl http://my-worker.localhost/
```

The CLI reads your `wrangler.jsonc`, bundles with esbuild if needed, and deploys.

## ES Modules

Standard ES module syntax:

```javascript
// src/index.js
export default {
  async fetch(request, env, ctx) {
    return new Response("Hello from ES module");
  }
};
```

No config changes needed — workerd detects ES modules automatically from `export default`.

## Service Worker Format

Classic Cloudflare Workers format:

```javascript
// src/index.js
addEventListener("fetch", (event) => {
  event.respondWith(new Response("Hello from Service Worker"));
});
```

This format is auto-detected when no `export default` is found.

## Service Bindings

Call another worker in the same process with zero network overhead.

**wrangler.jsonc**:
```jsonc
{
  "name": "api",
  "main": "src/index.js",
  "services": [
    { "binding": "AUTH", "service": "auth-worker" }
  ]
}
```

**api/src/index.js**:
```javascript
export default {
  async fetch(request, env) {
    const authResponse = await env.AUTH.fetch(
      new Request("http://auth.internal/verify", {
        headers: request.headers
      })
    );
    if (authResponse.status !== 200) {
      return new Response("Unauthorized", { status: 401 });
    }
    return new Response(JSON.stringify({ data: "authenticated" }));
  }
};
```

**auth-worker/src/index.js**:
```javascript
export default {
  async fetch(request) {
    const token = request.headers.get("Authorization");
    if (token === "Bearer valid-token-123") {
      return new Response(JSON.stringify({ valid: true }));
    }
    return new Response("Invalid token", { status: 401 });
  }
};
```

Service bindings use in-process HTTP — zero network latency.

## Durable Objects

Stateful objects with automatic storage.

**wrangler.jsonc**:
```jsonc
{
  "name": "fullstack",
  "main": "src/index.js",
  "durable_objects": {
    "bindings": [
      { "name": "COUNTER", "class_name": "Counter" },
      { "name": "ROOM", "class_name": "ChatRoom" }
    ]
  }
}
```

**src/index.js**:
```javascript
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/counter") {
      const id = env.COUNTER.idFromName("global");
      const stub = env.COUNTER.get(id);
      return stub.fetch(request);
    }

    if (url.pathname.startsWith("/chat/")) {
      const room = url.pathname.split("/")[2] || "lobby";
      const id = env.ROOM.idFromName(room);
      const stub = env.ROOM.get(id);
      return stub.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  }
};

// DO classes must be exported from the same module
export class Counter extends DurableObject {
  async fetch() {
    let value = (await this.ctx.storage.get("count")) || 0;
    value++;
    await this.ctx.storage.put("count", value);
    return new Response(JSON.stringify({ count: value }));
  }
}

export class ChatRoom extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET") {
      const messages = (await this.ctx.storage.get("messages")) || [];
      return new Response(JSON.stringify(messages));
    }
    if (request.method === "POST") {
      const { text } = await request.json();
      const messages = (await this.ctx.storage.get("messages")) || [];
      messages.push({ text, time: Date.now() });
      await this.ctx.storage.put("messages", messages);
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response("Method not allowed", { status: 405 });
  }
}
```

## WebSockets

Real-time two-way communication:

```javascript
export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      server.accept();
      server.addEventListener("message", (event) => {
        server.send(`Echo: ${event.data}`);
      });

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    return new Response("Use WebSocket at /ws", { status: 200 });
  }
};
```

Must be ES module format. WebSockets require workerd's protocol upgrade support.

## KV Namespace

Key-value storage:

**wrangler.jsonc**:
```jsonc
{
  "kv_namespaces": [
    { "binding": "CACHE", "id": "cache" }
  ]
}
```

**src/index.js**:
```javascript
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/kv" && request.method === "GET") {
      const key = url.searchParams.get("key");
      const value = await env.CACHE.get(key);
      return new Response(value || "null", {
        headers: { "Content-Type": "application/json" }
      });
    }

    if (url.pathname === "/kv" && request.method === "POST") {
      const { key, value } = await request.json();
      await env.CACHE.put(key, value);
      return new Response(JSON.stringify({ ok: true }));
    }
  }
};
```

KV requires a backend service. For local development, use in-memory stubs.

## R2 Buckets

Object storage:

**wrangler.jsonc**:
```jsonc
{
  "r2_buckets": [
    { "binding": "ASSETS", "bucket_name": "my-bucket" }
  ]
}
```

**src/index.js**:
```javascript
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/assets/foo") {
      const object = await env.ASSETS.get("foo");
      if (!object) return new Response("Not found", { status: 404 });
      return new Response(object.body, {
        headers: { "Content-Type": object.httpMetadata?.contentType || "application/octet-stream" }
      });
    }

    if (url.pathname === "/assets" && request.method === "PUT") {
      const body = await request.text();
      await env.ASSETS.put("foo", body, {
        httpMetadata: { contentType: "text/plain" }
      });
      return new Response(JSON.stringify({ ok: true }));
    }
  }
};
```

R2 requires a backend service. For local development, use stubs.

## Environment Variables

**wrangler.jsonc** vars (non-secret config, embedded in config):
```jsonc
{
  "vars": {
    "GREETING": "Hello!",
    "APP_ENV": "production"
  }
}
```

**.env** file (secrets, copied to server):
```bash
SECRET_KEY=sk-abc123
DATABASE_URL=postgres://...
```

**src/index.js**:
```javascript
export default {
  fetch(request, env) {
    console.log(env.APP_ENV);      // from vars
    console.log(env.SECRET_KEY);   // from .env
    return new Response(env.GREETING);
  }
};
```

The `.env` file is sourced by `workerd-start` before launching workerd.

## Static Assets

Serve HTML/CSS/JS directly from the worker:

```javascript
export default {
  fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(`<html><body><h1>Hello</h1></body></html>`, {
        headers: { "Content-Type": "text/html" },
      });
    }

    if (url.pathname === "/style.css") {
      return new Response(`body { font-family: sans-serif; }`, {
        headers: { "Content-Type": "text/css" },
      });
    }

    return new Response("Not found", { status: 404 });
  }
};
```

## Scaling

Add or remove instances:

```bash
# Show scaling advice for this server
workerd-scale info

# Set instance count (git-driven workflow)
ssh YOUR_USER@YOUR_SERVER
echo 2 > /etc/workerd/workers/hello/scale
workerd-scale set hello 2

# Or via CLI directly
workerd-scale set hello 3
```

Scaling only improves throughput when you have more CPU cores than instances. On a 2-core VM, 1 instance saturates both cores. On 4+ cores, scaling is linear.

## Deploying

**CLI (recommended)**:
```bash
cd ~/my-worker
werkerd deploy --port 8080
```

**Git push**:
```bash
# Push to trigger post-receive hook
git push deploy main
```

## Monitoring

### Health check endpoint

Every worker should implement `/healthz`:

```javascript
if (url.pathname === "/healthz") {
  return new Response("ok", { status: 200 });
}
```

nginx uses this to check instance health before routing traffic.

### Logs

```bash
# All workerd services
journalctl -u 'workerd@*' -f

# Specific worker
journalctl -u 'workerd@hello:8080.service' -f

# nginx access logs
tail -f /var/log/nginx/workerd-access.log

# nginx error logs
tail -f /var/log/nginx/workerd-error.log

# Deploy history
git --git-dir=/var/git/hello.git log --oneline
```

### Metrics

nginx status endpoint:
```bash
curl http://localhost/nginx_status
```

### Quick diagnostics

```bash
for p in 8080 8081 8082 8083 8085; do
  curl -sf http://localhost:$p/healthz && echo " :$p OK" || echo " :$p FAIL"
done
```
