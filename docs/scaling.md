# Scaling & Management

## Scale Up

```bash
workerd-scale up <worker-name> <port>
```

Example:
```bash
workerd-scale up hello 8082
```

This:
1. Checks the port is not already in use
2. Adds the port to `/etc/workerd/workers/hello/ports`
3. Generates the Cap'n Proto config for the new port
4. Creates a socket unit (`workerd-hello-8082.socket`)
5. Enables and starts the socket unit
6. Regenerates the Caddyfile and reloads Caddy

## Scale Down

```bash
workerd-scale down <worker-name> <port>
```

Example:
```bash
workerd-scale down hello 8082
```

This:
1. Stops and disables the socket unit
2. Removes the port from the ports file
3. Deletes the socket unit file
4. Reloads systemd
5. Regenerates the Caddyfile and reloads Caddy

### Safety Check

Scaling down the last port is blocked. You must always have at least one instance running.

## Scale to Zero

To fully stop a worker:
```bash
systemctl stop workerd-hello-8080.socket
systemctl disable workerd-hello-8080.socket
rm /etc/workerd/workers/hello/ports
rm /etc/systemd/system/workerd-hello-8080.socket
systemctl daemon-reload
```

## List Instances

```bash
workerd-scale list <worker-name>
```

Output:
```
hello: 2 instances
  8080  active running
  8081  active running
  ports file: /etc/workerd/workers/hello/ports
```

## Rollout Strategy

For rolling updates with zero downtime:

1. Scale up to 2+ instances (if only 1)
2. Deploy new code via git push
3. Post-receive hook restarts instances one at a time with 0.5s gap
4. Caddy health checks ensure each instance is healthy before routing traffic

## Resource Limits

Add resource limits to the service unit at `/etc/systemd/system/workerd@.service`:

```ini
[Service]
MemoryMax=512M
CPUQuota=50%
TasksMax=16
```

## Port Range

By convention:
| Range | Purpose |
|-------|---------|
| 8080-8099 | Worker instances (direct) |
| 80, 443 | Caddy reverse proxy |
| 9000-9099 | Full-stack / DO workers |
| 10000-10099 | Internal / admin |

## Monitoring Active Instances

```bash
# All workerd services
systemctl list-units 'workerd@*' --no-legend | wc -l

# All workerd sockets
systemctl list-units 'workerd-*-*.socket' --no-legend

# Worker-specific
systemctl status 'workerd@hello:*' --no-pager
```
