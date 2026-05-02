# Secrets & Environment Variables

workerd supports environment variables through three mechanisms:

## 1. Environment File (Recommended)

The `workerd-start` script sources a `.env` file from the worker directory before launching workerd:

```
/etc/workerd/workers/hello/.env
```

Format (standard key=value):
```bash
SECRET_KEY=sk-test-secret-key-1234567890
API_URL=https://example.com
DEBUG=false
```

Access in worker code:
```javascript
export default {
  fetch(request, env) {
    const key = env.SECRET_KEY;
    console.log(env.DEBUG);
    return new Response("ok");
  }
};
```

The config generator maps `manifest.env` entries to `fromEnvironment` bindings:
```json
{
  "env": ["SECRET_KEY", "API_URL", "DEBUG"]
}
```

Generates:
```capnp
bindings = [
  ( name = "SECRET_KEY", text = #fromEnvironment "SECRET_KEY" ),
  ( name = "API_URL", text = #fromEnvironment "API_URL" ),
  ( name = "DEBUG", text = #fromEnvironment "DEBUG" ),
]
```

## 2. Direct Text Bindings

For values that don't need to be secret (or for testing):
```json
{
  "bindings": [
    { "name": "CONFIG", "value": "{\"theme\":\"dark\"}" }
  ]
}
```

Generates:
```capnp
( name = "CONFIG", text = "{\"theme\":\"dark\"}" )
```

## 3. EnvironmentFile in Systemd

For system-level secrets:
```ini
# /etc/systemd/system/workerd@hello:8080.service.d/override.conf
[Service]
EnvironmentFile=/etc/workerd/secrets/hello.env
```

But prefer the `.env` file approach — it's already implemented by `workerd-start`.

## Best Practices

1. **Never commit `.env` to git**. Add to `.gitignore`:
   ```
   .env
   ```

2. **Use different `.env` per environment**:
   ```bash
   # Development
   /etc/workerd/workers/hello/.env.dev

   # Production
   /etc/workerd/workers/hello/.env.prod
   ```
   Copy the right one before starting.

3. **Rotate secrets by redeploying**:
   ```bash
   # Update .env on server
   scp .env.prod ubuntu@18.171.244.124:/etc/workerd/workers/hello/.env

   # Trigger restart to pick up new values
   ssh ubuntu@18.171.244.124 systemctl restart 'workerd@hello:*'
   ```

4. **Audit access**: The `.env` file is readable by the `workerd` user only:
   ```bash
   chmod 600 /etc/workerd/workers/hello/.env
   chown workerd:workerd /etc/workerd/workers/hello/.env
   ```

## Future: Vault / KMS Integration

For production secrets management, consider:
- HashiCorp Vault sidecar
- AWS Secrets Manager + a pre-start hook
- Cloudflare Secrets Store (if using wrangler deploy)

The `workerd-start` wrapper script can be extended to fetch secrets before launching workerd.
