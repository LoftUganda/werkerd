# Troubleshooting Guide

## Quick Diagnostics

```bash
# Everything running?
systemctl status nginx
systemctl list-units 'workerd@*' --no-legend --state=active | wc -l

# All workers healthy?
for port in 8080 8081 8082 8083 8085; do
  curl -sf http://localhost:$port/healthz && echo " :$port OK" || echo " :$port FAIL"
done

# nginx routing working?
curl -sf http://hello.localhost/ && echo " hello OK" || echo " hello FAIL"
curl -sf http://hono-app.localhost/ && echo " hono OK" || echo " hono FAIL"

# nginx status
curl -s http://localhost/nginx_status
```

---

## Service Not Starting

### Socket is listening but service inactive

```bash
systemctl status workerd@hello:8080.service
# → inactive (dead)
```

**Check**: Is socket activation blocked?

```bash
systemctl status workerd-hello-8080.socket
```

**Fix**: Trigger activation manually:

```bash
curl http://localhost:8080/
```

### Service is failed

```bash
systemctl status workerd@hello:8080.service
# → failed (Result: exit-code)
journalctl -u workerd@hello:8080.service -n 50 --no-pager
```

**Common errors and fixes**:

| Error | Cause | Fix |
|-------|-------|-----|
| `No such file: config.8080.capnp` | Config not generated | `workerd-gen-config hello 8080` |
| `embed path not found: index.js` | Worker file missing | Check `/etc/workerd/workers/hello/index.js` exists |
| `ES module parse error` | Wrong module type | Set `"main"` correctly in wrangler.jsonc |
| `embed cannot contain ".."` | Relative path escaping | Config generator handles this |
| `fromEnvironment: not found` | Env var not in manifest | Add to manifest's `env` array |

### Service starts but immediately dies

```bash
journalctl -u workerd@hello:8080.service
# → Exited with code 1, retrying
```

**Check .env file syntax**:

```bash
cat /etc/workerd/workers/hello/.env
# Must be KEY=VALUE, one per line, no spaces around =
# CORRECT:  SECRET_KEY=abc123
# WRONG:    SECRET_KEY = abc123
```

---

## Port Already in Use

```bash
ss -tlnp | grep :8080
# Shows what's using the port

# Kill it
sudo fuser -k 8080/tcp

# Or use a different port
werkerd deploy --port 8086
```

---

## nginx Not Proxying

### Symptom: Direct works, nginx returns 502

```bash
curl http://localhost:8080/          # works
curl http://hello.localhost/         # 502 Bad Gateway
```

**Diagnose**:

```bash
# 1. Check nginx is running
systemctl status nginx

# 2. Test nginx config
nginx -t

# 3. Check nginx logs
tail /var/log/nginx/workerd-error.log

# 4. Check upstream config
cat /etc/nginx/sites-available/workerd | grep -A10 "upstream workerd_hello"
```

**Fix**:

```bash
# Regenerate nginx config
workerd-gen-nginx
nginx -t && systemctl reload nginx
```

### Symptom: nginx 403 Forbidden on /nginx_status

This is expected — `/nginx_status` is restricted to `127.0.0.1`. From outside the server:

```bash
ssh YOUR_USER@YOUR_SERVER 'curl http://localhost/nginx_status'
```

### Symptom: nginx 502 only under load

```bash
# Check if upstream is saturated
ss -s | grep ESTABLISHED

# Check workerd CPU
top -p $(pgrep -f "workerd serve")
```

**Fix**: Scale up (if you have more CPU cores):

```bash
workerd-scale set hello 2
```

---

## Scaling Issues

### workerd-scale set does nothing

```bash
# Check scale file
cat /etc/workerd/workers/hello/scale

# Check running instances
workerd-scale list hello

# Apply manually
workerd-scale set hello 2
```

### Scaling doesn't improve RPS

This is **expected on 2-core VMs**. workerd is single-threaded. On a 2-core VM, multiple instances compete for the same CPU cores due to context switching.

**Check your CPU cores**:

```bash
workerd-scale info
# Server CPU cores: 2
# Scaling advice: marginal benefit (context switching)
```

**Fix**: Deploy to a server with 4+ cores for linear scaling.

### Scaling up adds ports but no instances start

```bash
# Check scale file has the right count
cat /etc/workerd/workers/hello/scale

# Manual apply
workerd-scale set hello 2
```

---

## Deployment Failures

### esbuild fails

```bash
# Make sure npm deps are installed
npm install
werkerd deploy --port 8080
```

### SCP upload fails

```bash
# Check SSH connectivity
ssh YOUR_USER@YOUR_SERVER 'echo connected'

# Check disk space
ssh YOUR_USER@YOUR_SERVER 'df -h'
```

### Health check fails after deploy

```bash
# Check if service started
systemctl status workerd@hello:8080.service

# Check logs
journalctl -u workerd@hello:8080.service -n 20

# Try restarting
systemctl restart workerd-hello-8080.socket
```

---

## Git Push Deploy Failing

### Permission denied (publickey)

```bash
git push deploy main
# → Permission denied (publickey)
```

**Fix**: Add your SSH key to the SSH user:

```bash
ssh-copy-id -i ~/.ssh/id_ed25519.pub YOUR_USER@YOUR_SERVER

# Or manually:
cat ~/.ssh/id_ed25519.pub | ssh YOUR_USER@YOUR_SERVER 'tee -a ~/.ssh/authorized_keys'
```

### Remote rejected (not a git directory)

```bash
git push deploy main
# → remote: fatal: not in a git directory
```

**Fix**: Create the bare repo on the server:

```bash
ssh YOUR_USER@YOUR_SERVER
sudo mkdir -p /var/git/hello.git
cd /var/git/hello.git
sudo git init --bare
sudo git symbolic-ref HEAD refs/heads/main
sudo chmod +x hooks/post-receive
```

### Push succeeds but no restart

```bash
# Check hook is executable
ssh YOUR_USER@YOUR_SERVER 'ls -la /var/git/hello.git/hooks/post-receive'

# Check hook content
ssh YOUR_USER@YOUR_SERVER 'cat /var/git/hello.git/hooks/post-receive'

# Run hook manually to test
ssh YOUR_USER@YOUR_SERVER 'cd /var/git/hello.git && git --git-dir=. log -1 --oneline'
```

---

## Environment Variables Not Working

### Symptom: `env.SECRET_KEY is undefined`

```bash
# 1. Check .env exists on server
ssh YOUR_USER@YOUR_SERVER 'cat /etc/workerd/workers/hello/.env'

# 2. Check .env is readable by workerd
ssh YOUR_USER@YOUR_SERVER 'ls -la /etc/workerd/workers/hello/.env'
ssh YOUR_USER@YOUR_SERVER 'chown workerd:workerd /etc/workerd/workers/hello/.env'

# 3. Check config has the binding
ssh YOUR_USER@YOUR_SERVER 'grep -i secret /etc/workerd/workers/hello/config.8080.capnp'
```

### Symptom: .env value not updating after change

```bash
# Restart the service to pick up new values
systemctl restart workerd-hello-8080.socket

# Or scale to force restart
workerd-scale set hello 2
```

---

## Service Bindings Broken

### Symptom: `env.AUTH is undefined`

```bash
# 1. Check wrangler.jsonc has the binding
grep -A5 services examples/api/wrangler.jsonc

# 2. Check config has both workers
ssh YOUR_USER@YOUR_SERVER 'cat /etc/workerd/workers/api/config.8090.capnp'
```

**Important**: Service bindings only work when both workers are in the **same Cap'n Proto config** (same process). For CLI-deployed workers, service bindings require manual config generation.

### Symptom: Service binding returns "No such file or directory"

The target worker file must exist in the same directory as the calling worker. For `werkerd deploy`, service bindings to separate workers need a custom deployment setup.

---

## Durable Objects Not Working

### Symptom: `No such Durable Object class: Counter`

```bash
# 1. Check DO binding in wrangler.jsonc
grep -A3 durable_objects examples/fullstack/wrangler.jsonc

# 2. Check worker exports the class
grep "class Counter" examples/fullstack/src/index.js

# 3. Check config has the binding
ssh YOUR_USER@YOUR_SERVER 'grep -i counter /etc/workerd/workers/fullstack/config.8085.capnp'
```

**Important**: DO classes must be exported from the **same module** that exports `default`.

### Symptom: DO state disappears after restart

This is **expected**. DO storage is in-memory by default. State survives within a process lifetime but not across restarts. For persistence, configure `localDisk` storage.

---

## Logs Reference

```bash
# All workerd services
journalctl -u 'workerd@*' -f

# Specific worker (all instances)
journalctl -u 'workerd@hello:*' -f

# Single instance
journalctl -u 'workerd@hello:8080.service' -f

# nginx access logs
tail -f /var/log/nginx/workerd-access.log

# nginx error logs
tail -f /var/log/nginx/workerd-error.log
```

---

## Reset Everything

If you're stuck with a completely broken state:

```bash
# 1. Stop everything
systemctl stop 'workerd@*' 2>/dev/null || true
systemctl stop 'workerd-*-*.socket' 2>/dev/null || true

# 2. Disable everything
systemctl disable 'workerd@*' 2>/dev/null || true
systemctl disable 'workerd-*-*.socket' 2>/dev/null || true

# 3. Remove socket units
rm -f /etc/systemd/system/workerd-*-*.socket

# 4. Reload systemd
systemctl daemon-reload

# 5. Clean up worker directories (optional)
rm -rf /etc/workerd/workers/<name>

# 6. Regenerate nginx
workerd-gen-nginx && systemctl reload nginx

# 7. Redeploy
werkerd deploy --port 8080
```

---

## Common Pitfalls

### 1. `.env` syntax must be strict

workerd-start uses `set -a; source .env; set +a`. This requires:
- `KEY=VALUE` format (no spaces around `=`)
- One variable per line
- No trailing whitespace
- No quotes around values (or they'll be included)

### 2. Scale file uses `\n` literally in heredocs

When generating nginx config, use `printf` or build strings properly. Literal `\n` in heredocs becomes the two characters backslash-n, not a newline.

### 3. workerd is single-threaded

On a 2-core VM, 2 instances compete for CPU via context switching. The performance is similar or worse than 1 instance. Scale only helps on 4+ core machines.

### 4. nginx must be reloaded after config changes

`workerd-gen-nginx` generates the config but nginx won't use it until you run `nginx -t && systemctl reload nginx`.

### 5. vite-react worker overwrites index.js

When deploying workers with npm deps, esbuild bundles node_modules into the output. The bundled file (not the original source) is what gets deployed. This is correct behavior — the bundle is what actually runs on workerd.

### 6. Scaling only helps with more CPU cores

workerd is single-threaded and uses 1 CPU core per instance. On a 2-core VM, 1 instance saturates both cores. Scaling to 2 instances adds context-switching overhead.

### 7. `manifest.json` required for scaling

`workerd-gen-config` (used by `workerd-scale set/start`) reads `manifest.json` from the worker directory. Without it, scaling fails with "manifest.json not found". The `werkerd deploy` CLI now creates this automatically. For manual setups, create it:

```json
{
  "name": "my-worker",
  "entrypoint": "index.js",
  "compatibilityDate": "2024-09-23"
}
```

### 8. Socket units persist — scaling won't re-create them

Socket units at `/etc/systemd/system/workerd-<worker>-<port>.socket` are persistent. If a port is in the `ports` file but the socket unit was manually deleted, `workerd-scale set` won't re-create it. To fix, run:

```bash
workerd-scale start my-worker <port>
```

---

## Diagnostic Commands Cheat Sheet

```bash
# Full system check
echo "=== nginx ===" && systemctl is-active nginx && curl -s http://localhost/nginx_status | head -3
echo "=== Workers ===" && for p in 8080 8081 8082 8083 8085; do curl -sf http://localhost:$p/healthz && echo " :$p OK" || echo " :$p FAIL"; done
echo "=== LB Routes ===" && for w in hello hono-app fullstack vite-react; do curl -sf http://$w.localhost/ > /dev/null && echo " $w OK" || echo " $w FAIL"; done
echo "=== nginx Config ===" && workerd-gen-nginx && nginx -t
```
