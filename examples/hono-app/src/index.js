// Hono on workerd — full framework features
// Deploy:  npx werkerd deploy --port 8082
// Develop: npx werkerd dev
//
// This is a normal Hono app. It works with `wrangler dev` (Cloudflare)
// AND `werkerd deploy` (self-hosted) — same code, same project.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

const app = new Hono();

// Global middleware
app.use("*", logger());
app.use("*", cors());

// Health check
app.get("/healthz", (c) => c.text("ok"));

// Home page
app.get("/", (c) => {
  return c.json({
    framework: "Hono",
    runtime: "workerd (self-hosted)",
    app: c.env.APP_NAME || "Hono on workerd",
    time: new Date().toISOString(),
    routes: [
      "GET  /",
      "GET  /healthz",
      "GET  /hello/:name",
      "POST /echo",
      "GET  /html",
    ],
  });
});

// Route params
app.get("/hello/:name", (c) => {
  const name = c.req.param("name");
  return c.json({ hello: name, time: new Date().toISOString() });
});

// POST body parsing
app.post("/echo", async (c) => {
  const body = await c.req.json();
  return c.json({ echo: body, time: new Date().toISOString() });
});

// HTML rendering
app.get("/html", (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Hono on workerd</title>
  <style>
    body { font-family: system-ui; max-width: 600px; margin: 4rem auto; padding: 0 1rem; }
    h1 { color: #333; }
    .card { background: #f5f5f5; border-radius: 8px; padding: 1.5rem; margin: 1rem 0; }
    code { background: #e0e0e0; padding: 0.2em 0.4em; border-radius: 3px; font-size: 0.9em; }
  </style>
</head>
<body>
  <h1>Hono on workerd</h1>
  <div class="card">
    <p>This HTML page is rendered by <strong>Hono</strong> running on <strong>workerd</strong> (self-hosted Cloudflare Workers runtime).</p>
    <p>Time: ${new Date().toISOString()}</p>
  </div>
  <div class="card">
    <p>Try these:</p>
    <ul>
      <li><code>curl /hello/world</code></li>
      <li><code>curl -X POST /echo -d '{"msg":"hi"}'</code></li>
    </ul>
  </div>
</body>
</html>`);
});

// Hono exports its fetch handler — workerd picks it up natively
export default app;
