# How-To Index

## Getting Started
- [Server Bootstrap](#server-bootstrap) — Set up a new WERKERD server from scratch
- [First Worker](#first-worker) — Deploy your first worker

## Workers
- [ES Modules](#es-modules) — Use modern ES module syntax
- [Service Worker Format](#service-worker-format) — Classic addEventListener format
- [Static Assets](#static-assets) — Serve HTML, CSS, JS files
- [SvelteKit on workerd](#sveltekit) — Deploy SvelteKit apps

## Features
- [Service Bindings](#service-bindings) — In-process RPC between workers
- [Durable Objects](#durable-objects) — Stateful serverless objects
- [KV Namespace](#kv) — Key-value storage
- [R2 Buckets](#r2) — Object storage
- [WebSockets](#websockets) — Real-time communication
- [Environment Variables](#environment-variables) — Secrets and config

## Operations
- [Scaling](#scaling) — Add/remove instances
- [Deploying](#deploying) — Git push, wrangler, or manual
- [Monitoring](#monitoring) — Logs, health checks, metrics

## Reference
- [manifest.json Schema](configuration.md#manifest-schema)
- [Cap'n Proto Config](configuration.md#capn-proto-config)
- [Systemd Units](architecture.md#layer-2-systemd-socket-activation)
- [Management Scripts](configuration.md#management-scripts)

---

## Server Bootstrap

From a fresh Ubuntu 22.04+ server:

```bash
# On your local machine
scp management-scripts/bootstrap.sh ubuntu@18.171.244.124:/tmp/
ssh ubuntu@18.171.244.124 sudo bash /tmp/bootstrap.sh
```

This installs: Node.js, workerd, Caddy, systemd units, and management scripts.

[Full guide: SKILL.md](SKILL.md#server-bootstrap)

## First Worker

1. Create a worker:

```javascript
// hello.js
export default {
  fetch(request) {
    return new Response(JSON.stringify({
      hello: "world",
      time: new Date().toISOString(),
    }), {
      headers: { "Content-Type": "application/json" },
    });
  }
};
```

2. Create a manifest:

```json
{
  "name": "hello",
  "compatibilityDate": "2024-09-23",
  "entrypoint": "hello.js"
}
```

3. Deploy via git push:

```bash
git init && git checkout -b main
git add hello.js manifest.json && git commit -m "hello"
git remote add deploy ssh://deploy@18.171.244.124:/var/git/hello.git
git push deploy main
```

4. Verify:

```bash
curl http://18.171.244.124:8080/
```

[Full guide: deploying.md](deploying.md)

## ES Modules

Use standard ES module syntax:

```javascript
// export default { fetch } format
export default {
  async fetch(request, env, ctx) {
    return new Response("Hello from ES module");
  }
};
```

The config generator auto-detects ES modules. Or set explicitly:

```json
{ "moduleType": "esm" }
```

Generates:
```capnp
modules = [ ( name = "worker.js", esModule = embed "worker.js" ) ]
```

## Service Worker Format

Classic Cloudflare Workers format:

```javascript
// addEventListener format
addEventListener("fetch", (event) => {
  event.respondWith(new Response("Hello from Service Worker"));
});
```

Set module type:
```json
{ "moduleType": "classic" }
```

Generates:
```capnp
serviceWorkerScript = embed "worker.js"
```

## Service Bindings

Call another worker without network overhead:

**manifest.json**:
```json
{
  "group": ["api", "auth"],
  "bindings": [
    { "name": "AUTH", "service": "auth" }
  ]
}
```

**api/worker.js**:
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

**auth/worker.js**:
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

All workers in a `group` share the same workerd process.
Service binding calls are in-process HTTP — zero network latency.

## Durable Objects

Stateful objects with automatic storage:

**manifest.json**:
```json
{
  "moduleType": "esm",
  "bindings": [
    { "name": "COUNTER", "durableObjectNamespace": { "className": "Counter" } },
    { "name": "CHATROOM", "durableObjectNamespace": { "className": "ChatRoom" } }
  ]
}
```

**worker.js**:
```javascript
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Durable Object counter
    if (url.pathname === "/counter") {
      const id = env.COUNTER.idFromName("global");
      const stub = env.COUNTER.get(id);
      return stub.fetch(request);
    }

    // Durable Object chatroom
    if (url.pathname.startsWith("/chat/")) {
      const room = url.pathname.split("/")[2] || "lobby";
      const id = env.CHATROOM.idFromName(room);
      const stub = env.CHATROOM.get(id);
      return stub.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  }
};

// Durable Object class
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

DO classes must be exported from the same module that exports `default`.

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

    // HTML page that connects to WebSocket
    return new Response(`
      <script>
        const ws = new WebSocket("ws://" + location.host + "/ws");
        ws.onmessage = (e) => console.log(e.data);
        ws.onopen = () => ws.send("Hello!");
      </script>
    `, { headers: { "Content-Type": "text/html" } });
  }
};
```

Must be ES module format (WebSocket not supported in Service Worker format).

## Environment Variables

**manifest.json**:
```json
{
  "env": ["SECRET_KEY", "API_URL", "DEBUG"]
}
```

**.env** (in worker directory):
```bash
SECRET_KEY=sk-test-1234567890
API_URL=https://api.example.com
DEBUG=false
```

Access in worker code:
```javascript
export default {
  fetch(request, env) {
    console.log(env.DEBUG);
    return fetch(env.API_URL, {
      headers: { Authorization: `Bearer ${env.SECRET_KEY}` }
    });
  }
};
```

## KV Namespace

Key-value storage:

**manifest.json**:
```json
{
  "bindings": [
    { "name": "CACHE", "kvNamespace": "cache" }
  ]
}
```

**worker.js**:
```javascript
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // GET /kv?key=foo
    if (url.pathname === "/kv" && request.method === "GET") {
      const key = url.searchParams.get("key");
      const value = await env.CACHE.get(key);
      return new Response(value || "null", {
        headers: { "Content-Type": "application/json" }
      });
    }

    // POST /kv { key: "foo", value: "bar" }
    if (url.pathname === "/kv" && request.method === "POST") {
      const { key, value } = await request.json();
      await env.CACHE.put(key, value);
      return new Response(JSON.stringify({ ok: true }));
    }
  }
};
```

Currently stores in-memory within the workerd process with `localDisk` storage.

## Static Assets

Serve HTML/CSS/JS:

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

For production static sites, use the `staticAssets` binding type:

**manifest.json**:
```json
{
  "bindings": [
    { "name": "ASSETS", "staticAssets": { "directory": "public" } }
  ]
}
```

## SvelteKit

To deploy a SvelteKit app on workerd:

1. **Build** the SvelteKit app with `@sveltejs/adapter-static` or a custom adapter.

2. **Create a worker** that handles SSR:

```javascript
// sveltekit-worker.js
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // SvelteKit render stub
    // In production, integrate with SvelteKit's server-side rendering
    const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>SvelteKit on workerd</title></head>
<body>
  <div id="app">
    <h1>SvelteKit on workerd</h1>
    <p>Route: ${url.pathname}</p>
    <p>Time: ${new Date().toISOString()}</p>
  </div>
  <script>console.log("hydrated");</script>
</body>
</html>`;

    return new Response(html, {
      headers: { "Content-Type": "text/html" },
    });
  }
};
```

3. **For full SSR**, use `adapter-cloudflare` which generates a `_worker.js` — rename to `worker.js` and deploy normally.

## Monitoring

### Health check endpoint

Every worker should implement:
```javascript
if (url.pathname === "/healthz") {
  return new Response("ok", { status: 200 });
}
```

Caddy uses this to check instance health before routing traffic.

### Metrics

Expose Prometheus-compatible metrics:
```javascript
if (url.pathname === "/metrics") {
  return new Response(JSON.stringify({
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  }), {
    headers: { "Content-Type": "application/json" },
  });
}
```

### Logs

```bash
# All worker logs
journalctl -u 'workerd@*' -f

# Specific worker
journalctl -u workerd@hello:8080.service -f

# Caddy access logs
journalctl -u caddy -f

# Deploy history
git --git-dir=/var/git/hello.git log --oneline
```
