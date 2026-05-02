// SvelteKit-style SSR Demo Worker
// Mimics @sveltejs/adapter-cloudflare output pattern
// Renders server-side HTML with progressive enhancement via htm (zero JS framework)

function renderHome() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SvelteKit Demo — WERKERD</title>
  <style>
    :root { --bg: #0f172a; --surface: #1e293b; --primary: #38bdf8; --accent: #818cf8; --text: #e2e8f0; --muted: #94a3b8; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }
    nav { background: var(--surface); padding: 16px 24px; display: flex; gap: 24px; align-items: center; border-bottom: 1px solid #334155; position: sticky; top: 0; z-index: 10; }
    nav a { color: var(--muted); text-decoration: none; font-size: 0.95rem; transition: color 0.15s; }
    nav a:hover, nav a.active { color: var(--primary); }
    nav .brand { font-weight: 700; font-size: 1.2rem; color: var(--primary); }
    main { max-width: 900px; margin: 0 auto; padding: 48px 24px; }
    h1 { font-size: 2.2rem; font-weight: 700; color: var(--primary); margin-bottom: 8px; }
    h2 { font-size: 1.4rem; color: var(--accent); margin: 32px 0 12px; }
    p { color: var(--muted); line-height: 1.7; margin-bottom: 16px; font-size: 1.05rem; }
    .card-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-top: 24px; }
    .stat-card { background: var(--surface); border: 1px solid #334155; border-radius: 10px; padding: 20px; text-align: center; }
    .stat-card .num { font-size: 2rem; font-weight: 700; color: var(--primary); }
    .stat-card .lbl { color: var(--muted); font-size: 0.85rem; margin-top: 4px; }
    pre { background: var(--surface); border: 1px solid #334155; border-radius: 8px; padding: 16px; overflow-x: auto; font-size: 0.9rem; color: var(--text); }
    code { color: var(--accent); }
    .todo-list { list-style: none; }
    .todo-list li { padding: 10px 16px; background: var(--surface); border: 1px solid #334155; border-radius: 8px; margin-bottom: 8px; display: flex; align-items: center; gap: 10px; cursor: pointer; transition: border-color 0.15s; }
    .todo-list li:hover { border-color: var(--primary); }
    .todo-list li.done { opacity: 0.5; text-decoration: line-through; }
    .todo-list .check { width: 18px; height: 18px; border: 2px solid #475569; border-radius: 4px; flex-shrink: 0; }
    .todo-list li.done .check { background: var(--primary); border-color: var(--primary); }
    form { background: var(--surface); border: 1px solid #334155; border-radius: 10px; padding: 20px; margin-top: 16px; display: flex; gap: 12px; }
    form input { flex: 1; padding: 10px 14px; background: var(--bg); border: 1px solid #334155; border-radius: 6px; color: var(--text); font-size: 0.95rem; }
    form button { padding: 10px 20px; background: var(--primary); color: #0f172a; border: none; border-radius: 6px; font-weight: 600; cursor: pointer; font-size: 0.95rem; }
    form button:hover { background: #7dd3fc; }
    footer { text-align: center; padding: 32px; color: var(--muted); font-size: 0.85rem; border-top: 1px solid #1e293b; margin-top: 48px; }
    .flash { background: #064e3b; border: 1px solid #059669; color: #6ee7b7; padding: 12px 16px; border-radius: 8px; margin-bottom: 20px; font-size: 0.95rem; }
  </style>
</head>
<body>
  <nav>
    <span class="brand">SvelteKit + WERKERD</span>
    <a href="/" class="active">Home</a>
    <a href="/about">About</a>
    <a href="/ssr">SSR Demo</a>
    <a href="/api">API</a>
  </nav>
  <main>
    <h1>Welcome to WERKERD</h1>
    <p>This page is <strong>server-side rendered</strong> by a SvelteKit-compatible worker running on <code>workerd</code> — Cloudflare's open-source Workers runtime.</p>

    <div class="card-grid">
      <div class="stat-card"><div class="num">{{time}}</div><div class="lbl">Server Time</div></div>
      <div class="stat-card"><div class="num">{{region}}</div><div class="lbl">Runtime</div></div>
      <div class="stat-card"><div class="num">{{requests}}</div><div class="lbl">Requests</div></div>
    </div>

    <h2>Todos (SSR + Form Actions)</h2>
    <ul class="todo-list" id="todos">
      {{todos}}
    </ul>
    <form method="POST" action="/?add" id="todoForm">
      <input type="text" name="todo" placeholder="What needs to be done?" required>
      <button type="submit">Add Todo</button>
    </form>

    {{flash}}
  </main>
  <footer>
    <p>Powered by workerd &bull; Self-hosted on Ubuntu &bull; No Cloudflare account needed</p>
  </footer>
  <script>
    // Progressive enhancement — intercept form submit for SPA-like feel
    document.getElementById('todoForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const fd = new FormData(form);
      const res = await fetch('/?add&_data=1&todo=' + encodeURIComponent(fd.get('todo')));
      if (res.ok) location.reload();
    });
    document.querySelectorAll('.todo-list li').forEach(li => {
      li.addEventListener('click', async () => {
        const id = li.dataset.id;
        const res = await fetch('/?toggle=' + id + '&_data=1');
        if (res.ok) location.reload();
      });
    });
  </script>
</body>
</html>`;
}

function renderAbout() {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>About — SvelteKit + WERKERD</title>
<style>
  :root { --bg: #0f172a; --surface: #1e293b; --primary: #38bdf8; --accent: #818cf8; --text: #e2e8f0; --muted: #94a3b8; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }
  nav { background: var(--surface); padding: 16px 24px; display: flex; gap: 24px; align-items: center; border-bottom: 1px solid #334155; }
  nav a { color: var(--muted); text-decoration: none; font-size: 0.95rem; }
  nav a:hover, nav a.active { color: var(--primary); }
  nav .brand { font-weight: 700; font-size: 1.2rem; color: var(--primary); }
  main { max-width: 700px; margin: 0 auto; padding: 48px 24px; }
  h1 { color: var(--primary); margin-bottom: 20px; }
  p { color: var(--muted); line-height: 1.8; margin-bottom: 16px; }
  code { color: var(--accent); background: var(--surface); padding: 2px 6px; border-radius: 4px; }
  pre { background: var(--surface); border: 1px solid #334155; border-radius: 8px; padding: 16px; overflow-x: auto; font-size: 0.9rem; margin: 20px 0; }
</style></head>
<body>
  <nav><span class="brand">SvelteKit + WERKERD</span><a href="/">Home</a><a href="/about" class="active">About</a></nav>
  <main>
    <h1>About WERKERD</h1>
    <p><strong>WERKERD</strong> is a self-hosted Cloudflare Workers platform built on <code>workerd</code> — the open-source runtime that powers Cloudflare Workers.</p>
    <p>It provides a SvelteKit-compatible deployment target with SSR, form actions, API routes, Durable Objects, KV, WebSockets, and environment variables — all running on your own hardware.</p>
    <h3>How it works</h3>
    <pre><code>git push → post-receive hook → checkout worker.js
      → workerd-gen-config → systemd restart → Caddy reload
    </code></pre>
    <p>Zero-downtime deploys via socket activation. Rolling restarts across multiple ports. Load balanced by Caddy with health checks.</p>
  </main>
</body></html>`;
}

// In-memory todo store
const todos = new Map();
let todoId = 0;

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    let flash = "";

    // Form actions (POST)
    if (request.method === "POST" || url.searchParams.get("add")) {
      const todo = url.searchParams.get("todo");
      if (todo) {
        todoId++;
        todos.set(String(todoId), { id: todoId, text: todo, done: false });
        flash = '<div class="flash">Todo added: ' + todo + '</div>';
      }
    }

    // Toggle
    const toggleId = url.searchParams.get("toggle");
    if (toggleId && todos.has(toggleId)) {
      const t = todos.get(toggleId);
      t.done = !t.done;
      todos.set(toggleId, t);
    }

    // JSON data endpoint (for progressive enhancement)
    if (url.searchParams.get("_data") === "1") {
      return Response.json({
        todos: [...todos.values()],
        total: todos.size,
        done: [...todos.values()].filter(t => t.done).length,
      });
    }

    // API endpoints
    if (path === "/api") {
      return Response.json({
        message: "SvelteKit-compatible API route",
        todos: [...todos.values()],
        runtime: "workerd",
        region: "self-hosted",
        version: "1.0.0",
      });
    }

    if (path === "/api/todos") {
      return Response.json({
        todos: [...todos.values()],
        total: todos.size,
        done: [...todos.values()].filter(t => t.done).length,
      });
    }

    // SSR pages
    if (path === "/about") {
      return new Response(renderAbout(), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Home (SSR + flash message)
    const todosHtml = [...todos.values()]
      .map(t => `<li data-id="${t.id}" class="${t.done ? 'done' : ''}"><span class="check"></span>${t.text}${t.done ? '' : ''}</li>`)
      .join("\n") || '<li style="opacity:0.5;text-decoration:none">No todos yet. Add one above!</li>';

    const html = renderHome()
      .replace("{{time}}", new Date().toISOString())
      .replace("{{region}}", "workerd (self-hosted)")
      .replace("{{requests}}", String(todoId + 1))
      .replace("{{todos}}", todosHtml)
      .replace("{{flash}}", flash);

    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
};
