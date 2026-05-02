// WERKERD Fullstack Worker — ES Module
// Durable Objects (Counter, ChatRoom) + KV + WebSockets + Env Vars + HTML Dashboard
export { Counter, ChatRoom };

// ── Durable Object: Counter (global durable state) ──
class Counter {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "");

    let count = (await this.state.storage.get("count")) || 0;

    if (path.endsWith("/increment")) {
      count++;
      await this.state.storage.put("count", count);
    } else if (path.endsWith("/decrement")) {
      count--;
      await this.state.storage.put("count", count);
    } else if (path.endsWith("/reset")) {
      count = 0;
      await this.state.storage.put("count", count);
    }

    return new Response(JSON.stringify({
      object: "Counter",
      counter: count,
      doId: this.state.id.toString(),
    }), {
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

// ── HTML Dashboard ──
const HOME_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WERKERD Fullstack</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0a0a1a; color: #e0e0e0; min-height: 100vh; }
    .hero { background: linear-gradient(135deg, #1a1a3e, #0d0d2b); padding: 60px 20px; text-align: center; border-bottom: 1px solid #2a2a5e; }
    .hero h1 { font-size: 2.5rem; background: linear-gradient(90deg, #6366f1, #a855f7); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-bottom: 10px; }
    .hero p { color: #888; font-size: 1.1rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; padding: 40px 20px; max-width: 1100px; margin: 0 auto; }
    .card { background: #12122a; border: 1px solid #2a2a5e; border-radius: 12px; padding: 24px; }
    .card:hover { border-color: #6366f1; }
    .card h3 { color: #a5b4fc; margin-bottom: 8px; font-size: 1.15rem; }
    .card .value { font-size: 2rem; font-weight: 700; color: #6366f1; font-variant-numeric: tabular-nums; }
    .card .label { color: #666; font-size: 0.85rem; margin-top: 4px; }
    .card button { margin: 6px 4px 0 0; padding: 8px 16px; background: #6366f1; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 0.9rem; }
    .card button:hover { background: #5558e6; }
    .card input { margin-top: 8px; width: 100%; padding: 8px 12px; background: #0a0a1a; border: 1px solid #2a2a5e; border-radius: 6px; color: #e0e0e0; font-size: 0.9rem; }
    #log { max-width: 1100px; margin: 0 auto 40px; padding: 0 20px; }
    #log .entry { background: #12122a; border: 1px solid #2a2a5e; border-radius: 8px; padding: 10px 16px; margin-bottom: 8px; font-family: monospace; font-size: 0.85rem; }
    .ws-status { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
    .ws-status.connected { background: #22c55e; }
    .ws-status.disconnected { background: #ef4444; }
    .ws-status.awaiting { background: #f59e0b; animation: pulse 1s infinite; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
  </style>
</head>
<body>
  <div class="hero">
    <h1>WERKERD Fullstack</h1>
    <p>Self-hosted Cloudflare Workers — Durable Objects · KV · WebSockets · Env Vars</p>
  </div>
  <div class="grid">
    <div class="card">
      <h3>Durable Object Counter</h3>
      <div class="value" id="counter">—</div>
      <div class="label">global durable state (persisted in DO storage)</div>
      <button onclick="callDO('increment')">+1 Increment</button>
      <button onclick="callDO('decrement')">-1 Decrement</button>
      <button onclick="callDO('reset')">Reset</button>
    </div>
    <div class="card">
      <h3>KV Store</h3>
      <div class="value" id="kvVal">—</div>
      <div class="label">key: greeting</div>
      <button onclick="callJSON('/kv/greeting')">Read KV</button>
      <input id="kvInput" placeholder="Set value..." />
      <button onclick="callJSON('/kv/greeting?value='+encodeURIComponent(document.getElementById('kvInput').value))">Write KV</button>
    </div>
    <div class="card">
      <h3>Environment</h3>
      <div class="value" id="envVal">—</div>
      <div class="label">SECRET_KEY prefix</div>
      <button onclick="callJSON('/env')">Check Env</button>
    </div>
    <div class="card">
      <h3>WebSocket Chat</h3>
      <div class="value"><span class="ws-status" id="wsDot"></span><span id="wsState">disconnected</span></div>
      <div class="label" id="wsMessages">0 messages</div>
      <input id="wsInput" placeholder="Type a message..." />
      <button onclick="wsSend()">Send</button>
      <button onclick="wsConnect()">Connect</button>
    </div>
    <div class="card">
      <h3>Request Count</h3>
      <div class="value" id="reqCount">—</div>
      <div class="label">total fetches to this worker</div>
      <button onclick="callJSON('/reqcount')">Count me!</button>
    </div>
    <div class="card">
      <h3>Diagnostics</h3>
      <div class="value" id="diagVal">—</div>
      <div class="label">bindings available</div>
      <button onclick="callJSON('/diag')">Get Diag</button>
    </div>
  </div>
  <div id="log"></div>
  <script>
    let ws = null, msgCount = 0;
    function log(msg) {
      const d = document.getElementById('log');
      d.insertAdjacentHTML('afterbegin','<div class="entry">'+new Date().toLocaleTimeString()+' '+msg+'</div>');
      if(d.children.length>30) d.lastChild.remove();
    }
    async function callJSON(path) {
      const r = await fetch(path), data = await r.json();
      log('GET '+path+' → '+JSON.stringify(data).slice(0,80));
      if(data.counter!==undefined) document.getElementById('counter').textContent = data.counter;
      if(data.kvValue!==undefined) document.getElementById('kvVal').textContent = data.kvValue;
      if(data.envPrefix!==undefined) document.getElementById('envVal').textContent = data.envPrefix;
      if(data.requestCount!==undefined) document.getElementById('reqCount').textContent = data.requestCount;
      if(data.hasDO!==undefined) document.getElementById('diagVal').textContent = 'DO:'+data.hasDO+' KV:'+data.hasKV+' WS:'+data.isWebSocketEnabled;
      return data;
    }
    async function callDO(action) {
      const r = await fetch('/counter/'+action, { method: 'POST' });
      const data = await r.json();
      document.getElementById('counter').textContent = data.counter;
      log('DO '+action+' → '+data.counter);
    }
    function wsConnect() {
      if(ws) ws.close();
      const proto = location.protocol==='https:'?'wss:':'ws:';
      ws = new WebSocket(proto+'//'+location.host+'/ws');
      document.getElementById('wsDot').className = 'ws-status awaiting';
      ws.onopen = () => {
        document.getElementById('wsDot').className = 'ws-status connected';
        document.getElementById('wsState').textContent = 'connected';
        log('WebSocket connected');
      };
      ws.onclose = () => {
        document.getElementById('wsDot').className = 'ws-status disconnected';
        document.getElementById('wsState').textContent = 'disconnected';
        log('WebSocket disconnected');
      };
      ws.onerror = () => log('WebSocket error');
      ws.onmessage = (e) => {
        msgCount++;
        document.getElementById('wsMessages').textContent = msgCount+' messages';
        log('WS ← '+e.data);
      };
    }
    function wsSend() {
      const inp = document.getElementById('wsInput');
      if(!ws||ws.readyState!==WebSocket.OPEN) return alert('Not connected');
      ws.send(inp.value||'ping');
      log('WS → '+(inp.value||'ping'));
      inp.value='';
    }
    // Init
    callJSON('/reqcount');
    callJSON('/kv/greeting');
    callJSON('/env');
    callJSON('/diag');
  </script>
</body>
</html>`;

// ── Main Fetch Handler ──
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    requestCount++;

    if (path === "/healthz") {
      return new Response("ok", { status: 200 });
    }

    if (path === "/reqcount") {
      return Response.json({ requestCount });
    }

    // Home — HTML dashboard
    if (path === "/") {
      if (env.HOME_HTML) {
        return new Response(env.HOME_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      return new Response(HOME_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Durable Object: Counter
    if (path.startsWith("/counter/")) {
      const id = env.COUNTER.idFromName("global");
      const stub = env.COUNTER.get(id);
      return stub.fetch(request);
    }
    if (path === "/counter") {
      return callDODiag(env);
    }

    // KV
    if (path.startsWith("/kv/")) {
      const key = path.replace(/^\/kv\//, "");
      const value = url.searchParams.get("value");

      if (request.method === "GET" && key) {
        const val = kvStore.get(key) || "(empty)";
        return Response.json({ kvKey: key, kvValue: val, storeSize: kvStore.size });
      }
      if ((request.method === "POST" || request.method === "PUT" || request.method === "GET") && key && value) {
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
      });
    }

    // WebSocket
    if (path === "/ws") {
      const id = env.CHATROOM.idFromName("main");
      const stub = env.CHATROOM.get(id);
      return stub.fetch(request);
    }

    // Diagnostics
    if (path === "/diag") {
      const diag = {
        hasDO: !!env.COUNTER,
        hasKV: !!env.STORE,
        hasChatroom: !!env.CHATROOM,
        hasSecretKey: !!env.SECRET_KEY,
        isWebSocketEnabled: typeof WebSocketPair !== "undefined",
        requestCount,
        envKeys: Object.keys(env).filter(k => typeof env[k] !== "function" && typeof env[k] !== "object"),
      };
      if (env.COUNTER) {
        try {
          const id = env.COUNTER.idFromName("diag");
          const stub = env.COUNTER.get(id);
          const r = await stub.fetch(new Request("http://d/internal"));
          diag.doTest = await r.json();
        } catch (e) {
          diag.doError = e.message;
        }
      }
      return Response.json(diag);
    }

    return new Response("Not found", { status: 404 });
  },
};

async function callDODiag(env) {
  try {
    const id = env.COUNTER.idFromName("global");
    const stub = env.COUNTER.get(id);
    const r = await stub.fetch(new Request("http://d/"));
    return r;
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
