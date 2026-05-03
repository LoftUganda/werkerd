# Deploying Workers

werkerd supports three deployment methods: CLI deploy (recommended), git push, and manual SCP.

## Deployment Methods

| Method | Best For | Zero Downtime |
|--------|----------|---------------|
| `werkerd deploy` (CLI) | Single workers, quick iteration | Via rolling restart |
| Git push | Automated CI/CD pipelines | Yes |
| SCP + restart | Debugging, one-off fixes | No |

## CLI Deploy (Recommended)

The `werkerd deploy` CLI reads your `wrangler.jsonc`, bundles with esbuild, uploads, and starts the service — zero config changes.

```bash
# Install CLI
cd werkerd-cli && npm install && npm link

# Deploy any Cloudflare Workers project
cd ~/my-worker
werkerd deploy --port 8080
```

What it does:
1. Reads `wrangler.jsonc` from current directory
2. Auto-detects npm dependencies and bundles with esbuild if needed
3. Generates Cap'n Proto config for workerd
4. Copies `.env` from project (if exists) for secrets
5. Uploads everything to server via SCP
6. Creates systemd socket unit and starts the service
7. Regenerates nginx config and reloads nginx
8. Health-checks the endpoint

Options:
```bash
werkerd deploy --port 8080           # Deploy to port 8080 (default)
WERKERD_SERVER=root@my-server.com werkerd deploy  # Override server
```

## Git Push Deploy

### Server Setup (One-Time)

On the server:

```bash
# Create bare git repo
sudo mkdir -p /var/git/my-worker.git
cd /var/git/my-worker.git
sudo git init --bare
sudo git symbolic-ref HEAD refs/heads/main

# Copy post-receive hook
sudo cp /usr/local/bin/post-receive-template /var/git/my-worker.git/hooks/post-receive
sudo sed -i 's/PLACEHOLDER/my-worker/' /var/git/my-worker.git/hooks/post-receive
sudo chmod +x /var/git/my-worker.git/hooks/post-receive

# Set up worker directory
sudo mkdir -p /etc/workerd/workers/my-worker
echo "8080" | sudo tee /etc/workerd/workers/my-worker/ports
echo "1" | sudo tee /etc/workerd/workers/my-worker/scale  # start with 1 instance

# Generate initial Cap'n Proto config
sudo workerd-gen-config my-worker 8080

# Start the worker
sudo workerd-scale start my-worker 8080
```

### Local Setup

```bash
# In your worker project directory
git init
git checkout -b main
git add worker.js wrangler.jsonc
git commit -m "initial deploy"

# Add remote (deploy user needs SSH key access)
git remote add deploy ssh://deploy@18.171.244.124:/var/git/my-worker.git

git push deploy main
```

The `deploy` user's SSH public key must be in `/home/deploy/.ssh/authorized_keys` on the server.

### How the Post-Receive Hook Works

```bash
#!/bin/bash
# /var/git/<worker>.git/hooks/post-receive

WORKER="PLACEHOLDER"
GIT_DIR="/var/git/${WORKER}.git"
DEPLOY_DIR="/etc/workerd/workers/${WORKER}"
PORTS_FILE="${DEPLOY_DIR}/ports"

while read oldrev newrev refname; do
    [ "$refname" = "refs/heads/main" ] || continue

    # 1. Checkout worker.js to deploy dir
    git --work-tree="$DEPLOY_DIR" --git-dir="$GIT_DIR" checkout -f main -- worker.js

    # 2. Regenerate configs for all active ports
    while IFS= read -r port; do
        workerd-gen-config "$WORKER" "$port"
    done < "$PORTS_FILE"

    # 3. Regenerate nginx config and reload
    workerd-gen-nginx
    nginx -t && systemctl reload nginx

    # 4. Rolling restart (zero downtime)
    while IFS= read -r port; do
        systemctl restart "workerd@${WORKER}:${port}"
        sleep 0.5
    done < "$PORTS_FILE"
done
```

### Scaling via Git Push

To scale a worker, edit the scale file and push:

```bash
# Locally: change scale file
echo 2 > /etc/workerd/workers/my-worker/scale
git add -A && git commit && git push deploy main

# Server post-receive hook applies: workerd-scale set my-worker 2
```

The post-receive hook reads the `scale` file after checkout and calls `workerd-scale set`.

### Multi-Worker Groups (Service Bindings)

If your worker uses service bindings to other workers in the same process group:

```
my-project/
  worker.js          ← Main worker (api)
  wrangler.jsonc      ← Lists services: [{ binding: "AUTH", service: "auth" }]
  auth-worker.js      ← Group member worker (copied by hook)
```

The post-receive hook can copy group workers:

```bash
if git --git-dir="$GIT_DIR" cat-file -e "$newrev:auth-worker.js" 2>/dev/null; then
    git --git-dir="$GIT_DIR" cat-file blob "$newrev:auth-worker.js" > "$DEPLOY_DIR/group-auth.js"
fi
```

## Manual SCP Deploy

For one-off debugging or when git isn't set up:

```bash
# Upload worker.js directly
scp worker.js root@18.171.244.124:/etc/workerd/workers/my-worker/

# Restart
ssh root@18.171.244.124 systemctl restart 'workerd@my-worker:*'
```

## Rollback

```bash
# View git history on server
ssh root@18.171.244.124 git --git-dir=/var/git/my-worker.git log --oneline

# Checkout a previous commit
ssh root@18.171.244.124
cd /etc/workerd/workers/my-worker
git --git-dir=/var/git/my-worker.git checkout <commit-hash> -- worker.js
workerd-gen-config my-worker 8080
systemctl restart 'workerd@my-worker:*'
```

## Post-Deploy Verification

```bash
# Check service status
ssh root@18.171.244.124 systemctl status 'workerd@my-worker:*'

# Check direct port access
curl -s http://18.171.244.124:8080/

# Check via nginx LB
curl -s http://my-worker.localhost/

# Health check
curl -sf http://localhost:8080/healthz && echo " OK" || echo " FAIL"

# View logs
ssh root@18.171.244.124 journalctl -u 'workerd@my-worker:*' -n 20

# nginx status
ssh root@18.171.244.124 curl -s http://localhost/nginx_status
```

## Environment-Specific Deploys

Use different worker names for different environments:

```bash
# Staging
werkerd deploy --port 8081  # worker name from wrangler.jsonc
# Or override:
NAME=my-worker-staging werkerd deploy --port 8081
```

## Cron / Scheduled Workers

workerd supports cron triggers via the Cap'n Proto config. Use `workerd-gen-config` with a modified config, or set up a systemd timer:

```bash
# Create a timer for hourly cron
cat > /etc/systemd/system/workerd-my-worker-cron.timer <<EOF
[Unit]
Description=Hourly cron trigger for my-worker

[Timer]
OnCalendar=*:0:0
Persistent=true

[Install]
WantedBy=timers.target
EOF
```

## Deploy Checklist

Before deploying:

- [ ] `wrangler.jsonc` has correct `name`, `main`, `compatibility_date`
- [ ] Worker code is in `src/index.js` (or wherever `main` points)
- [ ] `.env` exists for secrets (will be copied to server)
- [ ] `npm install` run if the project has dependencies
- [ ] Worker responds on `/healthz` with `200 OK`
