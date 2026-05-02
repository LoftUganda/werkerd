// WERKERD Fullstack Worker — ES Module
// Durable Objects (Counter, ChatRoom) + KV + WebSockets + Env Vars + HTML Dashboard

export { Counter, ChatRoom };

// ── Durable Object: Counter ──
class Counter {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "");
    let count = (await this.state.storage.get("count")) || 0;
    if (path.endsWith("/increment")) { count++; await this.state.storage.put("count", count); }
    else if (path.endsWith("/decrement")) { count--; await this.state.storage.put("count", count); }
    else if (path.endsWith("/reset")) { count = 0; await this.state.storage.put("count", count); }
    return new Response(JSON.stringify({ object: "Counter", counter: count, doId: this.state.id.toString() }), {
      headers: { "Content-Type": "application/json" },
    });
  }
}

// ── Durable Object: ChatRoom (WebSocket hub) ──
class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = [];
    this.messageLog = [];
  }
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.sessions.push(server);
    const idx = this.sessions.length;
    server.addEventListener("message", (event) => {
      this.messageLog.push({ from: idx, at: Date.now(), text: event.data });
      if (this.messageLog.length > 100) this.messageLog.shift();
      for (const s of this.sessions) {
        if (s !== server && s.readyState === 1) {
          s.send(`[User ${idx}]: ${event.data}`);
        }
      }
    });
    server.addEventListener("close", () => {
      this.sessions = this.sessions.filter(s => s !== server);
    });
    server.send(`Welcome! You are user ${idx}. ${this.sessions.length} online.`);
    return new Response(null, { status: 101, webSocket: client });
  }
}

// ── In-Memory KV ──
const kvStore = new Map();
let requestCount = 0;

// ── Main Fetch Handler ──
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    requestCount++;

    // Health check
    if (path === "/healthz") return new Response("ok", { status: 200 });

    // Config Diag
    if (path === "/diag") {
      return Response.json({
        hasDO: !!env.COUNTER,
        hasChatroom: !!env.CHATROOM,
        hasKV: !!env.STORE,
        hasSecretKey: !!env.SECRET_KEY,
        isWebSocketEnabled: typeof WebSocketPair !== "undefined",
        requestCount,
        envKeys: Object.keys(env).filter(k => typeof env[k] !== "function" && typeof env[k] !== "object"),
      });
    }

    // Request count
    if (path === "/reqcount") {
      return Response.json({ requestCount });
    }

    // Simple home JSON
    if (path === "/" || path === "") {
      const html = env.HOME_HTML;
      if (html && html.length > 0) {
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      return Response.json({
        name: "fullstack",
        features: ["Durable Objects", "KV", "WebSockets", "Env Vars"],
        requestCount,
        endpoints: ["GET /diag", "GET /healthz", "GET /counter", "POST /counter/increment", "POST /counter/decrement", "POST /counter/reset", "GET /kv/:key", "POST /kv/:key?value=X", "GET /ws (WebSocket)"],
      });
    }

    // Durable Object: Counter
    if (path.startsWith("/counter")) {
      const id = env.COUNTER.idFromName("global");
      const stub = env.COUNTER.get(id);
      return stub.fetch(request);
    }

    // KV
    if (path.startsWith("/kv/")) {
      const key = path.replace(/^\/kv\//, "");
      const value = url.searchParams.get("value");
      if (request.method === "GET" && key && !value) {
        const val = kvStore.get(key) || "(empty)";
        return Response.json({ kvKey: key, kvValue: val, storeSize: kvStore.size });
      }
      if (key && value) {
        kvStore.set(key, value);
        return Response.json({ kvKey: key, kvValue: value, storeSize: kvStore.size, written: true });
      }
      if (request.method === "DELETE" && key) {
        kvStore.delete(key);
        return Response.json({ kvKey: key, deleted: true, storeSize: kvStore.size });
      }
      return Response.json({ keys: [...kvStore.keys()], count: kvStore.size });
    }

    // Environment
    if (path === "/env") {
      return Response.json({
        hasSecretKey: !!env.SECRET_KEY,
        envPrefix: env.SECRET_KEY ? env.SECRET_KEY.slice(0, 5) + "..." : "not set",
        envKeyCount: Object.keys(env).filter(k => typeof env[k] === "string").length,
        appEnv: env.APP_ENV || "not set",
      });
    }

    // WebSocket
    if (path === "/ws") {
      const id = env.CHATROOM.idFromName("main");
      const stub = env.CHATROOM.get(id);
      return stub.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
};
