// Auth Worker (ES module) — internal service
// Called via service binding from the API worker

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/verify") {
      try {
        const body = await request.json();
        const token = body.token || "";

        // Simple token validation
        const valid = token.startsWith("valid-") || token === "test-token-123";

        if (valid) {
          return new Response(JSON.stringify({
            verified: true,
            user: "example-user",
            scopes: ["read", "write"],
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        return new Response(JSON.stringify({
          verified: false,
          reason: "invalid_token",
        }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });

      } catch (err) {
        return new Response("invalid request body", { status: 400 });
      }
    }

    return new Response(JSON.stringify({
      worker: "auth",
      message: "Auth worker — use POST /verify",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },
};
