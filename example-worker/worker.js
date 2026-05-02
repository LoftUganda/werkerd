addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Healthcheck endpoint for Caddy health polling
  if (url.pathname === '/healthz') {
    return event.respondWith(new Response('ok', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    }));
  }

  // Main handler
  event.respondWith(new Response(JSON.stringify({
    message: 'Hello from self-hosted workerd!',
    worker: 'hello',
    time: new Date().toISOString(),
    url: event.request.url,
    method: event.request.method,
  }, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'X-Powered-By': 'workerd',
    },
  }));
});
