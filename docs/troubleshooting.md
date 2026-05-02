# Troubleshooting

## Service Not Starting

### Symptom: Socket is listening but service is not active
```
systemctl status workerd@hello:8080.service
→ inactive (dead)
```

**Check**: Is socket activation blocked?
```bash
systemctl status workerd-hello-8080.socket
```

**Fix**: Trigger activation by making a request:
```bash
curl http://localhost:8080/
```

### Symptom: Service is failed
```
systemctl status workerd@hello:8080.service
→ failed (Result: exit-code)
```

**Check journal**:
```bash
journalctl -u workerd@hello:8080.service -n 50 --no-pager
```

Common failures:

| Error | Cause | Fix |
|-------|-------|-----|
| `No such file: config.<port>.capnp` | Config not generated | `workerd-gen-config hello 8080` |
| `embed path not found: worker.js` | Worker file missing | Check `/etc/workerd/workers/hello/worker.js` exists |
| `ES module parse error` | Service Worker format used with `modules` | Set `"moduleType": "classic"` in manifest or use `export default` |
| `durableObjectNamespaces not recognized` | Old workerd binary | Remove `durableObjectNamespaces` from Config level |
| `embed cannot contain ".."` | Relative path escaping | Config generator copies group members locally |

### Symptom: Service starts but immediately dies
```
journalctl -u workerd@hello:8080.service
→ Exited with code 1, retrying
```

Check `.env` file syntax:
```bash
cat /etc/workerd/workers/hello/.env
# Must be KEY=VALUE one per line, no spaces around =
```

## Port Already in Use

```bash
ss -tlnp | grep :8080
# Shows something already on 8080

# Kill it
sudo fuser -k 8080/tcp

# Or use a different port
sudo workerd-scale up hello 8082
```

## Caddy Not Proxying

### Symptom: Direct port works but Caddy returns 502
```bash
curl localhost:8080/   → works
curl localhost:80/     → 502
```

**Check Caddyfile**:
```bash
cat /etc/caddy/Caddyfile
systemctl status caddy
```

**Fix**: Regenerate and reload:
```bash
workerd-gen-caddyfile
caddy reload --config /etc/caddy/Caddyfile
```

If Caddy complains about `lb_policy`:
```bash
# Remove the lb_policy line temporarily
sed -i '/lb_policy/d' /etc/caddy/Caddyfile
caddy fmt --overwrite /etc/caddy/Caddyfile
caddy reload --config /etc/caddy/Caddyfile
```

### Symptom: External IP works but domain doesn't
```bash
curl http://18.171.244.124/  → works
curl http://hello.example.com/ → connection refused
```

DNS is not configured. Either:
1. Set up DNS pointing to the server IP
2. Add the domain to Caddyfile and reload

## Caddy Performance Issues

### Symptom: High latency through Caddy LB

```
Direct workerd (localhost:8080): 5ms
Caddy LB (localhost:80): 50ms+        # >10x slower than direct
```

**Check**: Are connection pooling and keepalive enabled?

```bash
# Check current Caddy config
cat /etc/caddy/Caddyfile | grep -A10 "transport http"
```

**Fix**: Regenerate Caddyfile with connection pooling:
```bash
workerd-gen-caddyfile
caddy reload --config /etc/caddy/Caddyfile
```

The optimized config adds `transport http` blocks with `keepalive 30s`, `max_conns_per_host 200`, and `keepalive_idle_conns 100`. This eliminates the TCP 3-way handshake per request.

**Expected improvement**: 2,893 → 4,425 RPS (+53%), p99 from 757ms → 114ms (-85%)

### Symptom: Caddy returns 502 under load

```
Under heavy load: 502 Bad Gateway
```

**Common causes**:

| Cause | Diagnosis | Fix |
|---|---|---|
| Connection exhaustion | `ss -s` shows high established | Increase `max_conns_per_host` |
| FD limit hit | `ls /proc/$(pgrep caddy)/fd \| wc -l` near limit | `LimitNOFILE=65536` in systemd |
| Upstream saturated | Workerd CPU at 100% | Scale more instances |
| Health check timeout | `curl localhost:2019/metrics \| grep healthy` shows 0 | Check `/healthz` on all backends |
| GC pauses | Memory growth over time | Check Go runtime: `GODEBUG=gctrace=1` |

### Diagnostic Commands

```bash
# Caddy metrics (requires admin API enabled)
curl -s http://localhost:2019/metrics | grep -E "reverse_proxy|upstream"

# Active connections breakdown
ss -s

# File descriptor count
ls /proc/$(pgrep caddy)/fd | wc -l

# Established TCP connections
netstat -an | grep ESTABLISHED | wc -l

# Check OS limits
cat /proc/$(pgrep caddy)/limits | grep "open files"

# Per-port throughput (while under load)
for port in 8080 8081; do
  echo -n ":$port → $(curl -s -o /dev/null -w '%{time_total}s' localhost:$port/)$port "
done
```

### Benchmarking

```bash
# Baseline: direct workerd
wrk -t2 -c100 -d15s --latency http://localhost:8080/

# Through Caddy LB
wrk -t2 -c200 -d15s --latency http://localhost:80/

# External (real-world)
wrk -t4 -c100 -d15s --latency http://<public-ip>:8080/
```

## Git Push Failing

### Symptom: Permission denied (publickey)
```
git push deploy main
→ Permission denied (publickey)
```

**Fix**: Add your SSH key to the deploy user:
```bash
# On server
sudo -u deploy mkdir -p /home/deploy/.ssh
cat /home/ubuntu/.ssh/authorized_keys >> /home/deploy/.ssh/authorized_keys
```

### Symptom: Remote rejected
```
git push deploy main
→ remote: fatal: not in a git directory
```

The bare repo doesn't exist:
```bash
# On server
sudo mkdir -p /var/git/hello.git
cd /var/git/hello.git
sudo git init --bare
sudo git symbolic-ref HEAD refs/heads/main
```

### Symptom: Push succeeds but no restart
```
git push deploy main
→ Everything up-to-date
```

Either the hook isn't executable or the branch ref didn't match:
```bash
# On server
ls -la /var/git/hello.git/hooks/post-receive
# Must be executable: chmod +x

cat /var/git/hello.git/hooks/post-receive
# Check `refname = refs/heads/main` matches your push branch
```

## Env Vars Not Working

### Symptom: env.VARIABLE is undefined
```
worker.js: env.SECRET_KEY is undefined
```

**Check**:
1. `.env` file exists: `cat /etc/workerd/workers/hello/.env`
2. `manifest.json` lists it: `"env": ["SECRET_KEY"]`
3. Config has `fromEnvironment` binding: `cat config.8080.capnp`
4. `.env` is readable by workerd user: `chown workerd:workerd .env`

## Service Bindings Broken

### Symptom: env.AUTH is undefined
```
worker.js: Cannot read properties of undefined (reading 'fetch')
```

**Check**:
1. `manifest.json` has binding: `"bindings": [{ "name": "AUTH", "service": "auth" }]`
2. Config has dual-service setup (both workers in same config)
3. Auth worker file exists: `ls /etc/workerd/workers/auth/worker.js`
4. Auth worker was copied into group: `ls /etc/workerd/workers/api/group-auth.js`

### Symptom: Service binding returns error
```
Auth worker error: No such file or directory
```

Group workers must be in the same directory as the leader worker. The config generator handles this by copying them as `group-{name}.js`.

## Durable Objects Not Working

### Symptom: DO class not found
```
Error: No such Durable Object class: Counter
```

**Check**:
1. `manifest.json` has DO binding: `"bindings": [{ "name": "COUNTER", "durableObjectNamespace": { "className": "Counter" } }]`
2. Worker exports the class: `export class Counter extends DurableObject { ... }`
3. DO classes must be exported from the same module as the fetch handler

## Logs

### View service logs
```bash
journalctl -u workerd@hello:8080.service -f     # Follow
journalctl -u workerd@hello:8080.service -n 50   # Last 50 lines
journalctl -u 'workerd@hello:*' -n 50            # All instances
```

### View Caddy logs
```bash
journalctl -u caddy -f
journalctl -u caddy --since "5 minutes ago"
```

### View deploy logs
```bash
# Deploy logs appear in git push output (post-receive stdout)
# Also check:
journalctl -u 'workerd@*' --since "1 minute ago"
```

## Reset Everything

If things get truly stuck:
```bash
# Kill all workerd processes
sudo pkill -f workerd

# Stop all socket units
systemctl stop 'workerd-*-*.socket' 2>/dev/null || true

# Disable all services
systemctl disable 'workerd@*' 2>/dev/null || true
systemctl disable 'workerd-*-*.socket' 2>/dev/null || true

# Clean up
rm -f /etc/systemd/system/workerd-*-*.socket

# Reload systemd
systemctl daemon-reload

# Regenerate everything
workerd-gen-config hello 8080
workerd-scale up hello 8080
```
