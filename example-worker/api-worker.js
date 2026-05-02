// API Worker (ES module) — group leader
// Calls auth worker via service binding before responding

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Healthcheck
    if (url.pathname === "/healthz") {
      return new Response("ok", { status: 200 });
    }

    // Diagnostics endpoint — show env and binding status
    if (url.pathname === "/diag") {
      const diag = {
        hasSecretKey: !!env.SECRET_KEY,
        secretKeyPrefix: env.SECRET_KEY ? env.SECRET_KEY.substring(0, 4) + "..." : null,
        hasAuthBinding: !!env.AUTH,
        time: new Date().toISOString(),
      };

      // Test the auth binding
      if (env.AUTH) {
        try {
          const authResp = await env.AUTH.fetch(
            new Request("http://auth.internal/verify", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ token: "test-token-123" }),
            })
          );
          diag.authBindingWorks = authResp.ok;
          diag.authResult = await authResp.json();
        } catch (err) {
          diag.authBindingError = err.message;
        }
      }

      return new Response(JSON.stringify(diag, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json", "X-Powered-By": "workerd" },
      });
    }

    // All other requests: check auth first
    const authHeader = request.headers.get("Authorization") || "";

    if (env.AUTH) {
      try {
        const authResp = await env.AUTH.fetch(
          new Request("http://auth.internal/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: authHeader.replace("Bearer ", "") }),
          })
        );

        if (!authResp.ok) {
          return new Response(JSON.stringify({
            error: "unauthorized",
            detail: await authResp.text(),
          }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
      } catch (err) {
        return new Response(JSON.stringify({
          error: "auth_service_unavailable",
          detail: err.message,
        }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Auth passed (or no auth binding configured)
    return new Response(JSON.stringify({
      message: "API worker responding",
      authHeaderPresent: !!authHeader,
      envSecretKey: env.SECRET_KEY ? "present" : "missing",
      worker: "api",
      time: new Date().toISOString(),
    }, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json", "X-Powered-By": "workerd" },
    });
  },
};
