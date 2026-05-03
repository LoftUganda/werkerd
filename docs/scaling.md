# Scaling & Management

werkerd uses **git-driven scaling** — edit a config file, push to server, instances start/stop automatically.

## workerd-scale Commands

```bash
workerd-scale info              # Show CPU cores and scaling advice
workerd-scale set <worker> <N>  # Set N instances (git-push workflow)
workerd-scale start <worker> <port>  # Start a worker on a port
workerd-scale stop <worker>     # Stop all instances
workerd-scale list <worker>     # Show scale and running instances
```

### workerd-scale info

Shows server CPU cores and scaling advice:

```bash
$ workerd-scale info
Server CPU cores: 2

Scaling advice:
  2 cores: scaling gives marginal benefit (context switching).
           For meaningful improvement: deploy to 4+ core VM.

Each workerd instance is single-threaded and uses 1 core.
To reach 1M RPS: need ~120 cores behind nginx (~8k RPS/core).
```

**Key insight**: On a 2-core VM, 1 instance already saturates both cores. Adding a 2nd instance adds context-switching overhead without throughput gain. Scaling only helps meaningfully on 4+ core VMs.

### workerd-scale set

Set the desired instance count. This is the git-driven workflow:

```bash
# 1. Locally: edit the scale file
echo 2 > /etc/workerd/workers/hello/scale
git add -A && git commit && git push

# 2. On server (via post-receive hook or manually):
workerd-scale set hello 2
```

What it does:
1. Reads `/etc/workerd/workers/<worker>/scale` for desired count
2. Compares to current instance count (from `ports` file)
3. **Scale up**: allocates new ports, generates configs (if `manifest.json` exists), creates socket units (if missing), starts services
4. **Scale down**: stops and removes socket units, updates `ports` file
5. Regenerates nginx config (`workerd-gen-nginx`)
6. Reloads nginx

### workerd-scale start

A `manifest.json` at `/etc/workerd/workers/<worker>/manifest.json` is required for config generation. The `werkerd deploy` CLI creates this automatically.

### workerd-scale start

Start a new worker instance on a specific port:

```bash
workerd-scale start hello 8081
```

Reads the `scale` file to determine desired count, then starts the instance.

### workerd-scale stop

Stop all running instances:

```bash
workerd-scale stop hello
```

Removes all socket units and regenerates nginx config.

### workerd-scale list

Show worker status:

```bash
$ workerd-scale list hello
Worker: hello
  Desired scale: 2 instance(s)
  Ports: 8080 8081
  Running services:
    workerd@hello:8080.service   active   running
    workerd@hello:8081.service   active   running
```

## Scale File

Location: `/etc/workerd/workers/<worker>/scale`

Contains a single integer — the desired instance count:

```
2
```

The scale file is the source of truth. Edit it locally, push to server, call `workerd-scale set`.

## Ports File

Location: `/etc/workerd/workers/<worker>/ports`

One port per line, each corresponding to a running instance:

```
8080
8081
```

This file is managed by `workerd-scale`. Do not edit manually.

## Git-Driven Workflow

```
Local machine                  Server
     │                           │
     │  git push                 │
     │ ─────────────────────────▶│ post-receive hook
     │                           │  1. checkout worker.js
     │                           │  2. workerd-scale set hello 2
     │                           │     (reads scale file)
     │                           │  3. nginx regenerates
     │                           │
```

The post-receive hook calls `workerd-scale set` after checking out new code, so pushing a new `scale` file automatically applies the new instance count.

## Rolling Restarts (Zero Downtime)

On `git push`, the post-receive hook restarts instances one at a time:

```bash
while IFS= read -r port; do
    systemctl restart "workerd@${WORKER}:${port}"
    sleep 0.5   # gap between restarts
done < "$PORTS_FILE"
```

nginx health checks ensure each instance is healthy before routing traffic.

## Scaling Considerations

| CPU Cores | Scaling Benefit | Recommendation |
|-----------|----------------|----------------|
| 1 | None | Don't scale — only 1 core available |
| 2 | Marginal | 1 instance is fine; 2 adds overhead |
| 4+ | Linear | Set instances = cores for full throughput |
| 8+ | Linear | Scale freely; ~8k RPS per instance |

Each workerd instance is **single-threaded** and occupies exactly 1 CPU core. A 4-core VM running 4 instances can handle ~4x the RPS of a single instance.

## Resource Limits

Add limits to `/etc/systemd/system/workerd@.service`:

```ini
[Service]
MemoryMax=512M
CPUQuota=50%
TasksMax=16
```

Or per-instance via drop-in:

```bash
mkdir -p /etc/systemd/system/workerd@hello:8080.service.d
cat > /etc/systemd/system/workerd@hello:8080.service.d/override.conf <<EOF
[Service]
MemoryMax=256M
EOF
```

## Port Range Conventions

| Range | Purpose |
|-------|---------|
| 8080-8099 | Worker instances (direct) |
| 80, 443 | nginx reverse proxy |
| 9000-9099 | Full-stack / DO workers |
| 10000-10099 | Internal / admin |

## Monitoring Active Instances

```bash
# All workerd services
systemctl list-units 'workerd@*' --no-legend --state=active | wc -l

# All socket units
systemctl list-units 'workerd-*-*.socket' --no-legend

# Worker-specific
systemctl status 'workerd@hello:*' --no-pager

# nginx status
curl http://localhost/nginx_status

# Active connections
ss -s | grep ESTABLISHED
```

## Scale to Zero

To fully stop a worker (not recommended — no traffic handling):

```bash
workerd-scale stop hello
# Then optionally remove the scale file:
rm /etc/workerd/workers/hello/scale
```

**Note**: Always keep at least one instance running for health checks to pass.
