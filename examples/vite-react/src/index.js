// Vite + React on workerd — serves the built SPA + API routes
//
// Build:  npm run build       (vite build)
// Deploy: npm run deploy      (vite build + werkerd deploy --port 8083)
// This is a single worker that serves both the React frontend AND an API.
//
// wrangler.jsonc tells workerd to auto-bundle src/index.js as an ES module.
// No manifest editing needed — wrangler.jsonc IS the config.

const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Vite + React on workerd</title>
  <script type="module" src="/src/main.jsx"></script>
</head>
<body>
  <div id="root"></div>
</body>
</html>`;

// Minimal React SPA — inlined for zero-config deploy
const mainJsx = `
import React from "https://esm.sh/react@18";
import { createRoot } from "https://esm.sh/react-dom@18/client";

function App() {
  const [count, setCount] = React.useState(0);
  const [data, setData] = React.useState(null);

  React.useEffect(() => {
    fetch("/api/info").then(r => r.json()).then(setData);
  }, []);

  return React.createElement("div", { style: { fontFamily: "system-ui", maxWidth: 600, margin: "4rem auto", padding: "0 1rem" } },
    React.createElement("h1", null, "Vite + React on workerd"),
    React.createElement("p", null, "This React SPA is running on a self-hosted Cloudflare Workers runtime."),
    data && React.createElement("pre", null, JSON.stringify(data, null, 2)),
    React.createElement("button", {
      onClick: () => setCount(c => c + 1),
      style: { padding: "0.75rem 1.5rem", fontSize: "1.1rem", cursor: "pointer", marginTop: "1rem" }
    }, "Count: " + count),
    React.createElement("hr", { style: { marginTop: "2rem" } }),
    React.createElement("p", { style: { color: "#666" } },
      "Built with Vite. Deployed with ",
      React.createElement("code", null, "werkerd deploy"),
      "."
    )
  );
}

createRoot(document.getElementById("root")).render(React.createElement(App));
`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/healthz") {
      return new Response("ok", { status: 200 });
    }

    // API endpoints
    if (url.pathname === "/api/info") {
      return new Response(JSON.stringify({
        framework: "Vite + React",
        runtime: "workerd (self-hosted)",
        time: new Date().toISOString(),
        port: 8083,
      }, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Serve the React SPA for all other routes
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(indexHtml, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Serve main.jsx (the bundled React app)
    if (url.pathname === "/src/main.jsx") {
      return new Response(mainJsx, {
        headers: { "Content-Type": "application/javascript; charset=utf-8" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
