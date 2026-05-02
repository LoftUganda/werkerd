// hello worker — minimal Cloudflare Worker
// Deploy: npx werkerd deploy

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Health check endpoint
    if (url.pathname === "/healthz") {
      return new Response("ok", { status: 200 });
    }

    // Diagnostics
    if (url.pathname === "/diag") {
      return new Response(JSON.stringify({
        worker: "hello",
        greeting: env.GREETING,
        time: new Date().toISOString(),
        runtime: "workerd",
      }, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Default response
    return new Response(JSON.stringify({
      message: env.GREETING || "Hello!",
      worker: "hello",
      time: new Date().toISOString(),
      url: request.url,
      method: request.method,
    }, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "X-Powered-By": "workerd",
      },
    });
  },
};
