# Deploying Workers

This guide covers deploying workers to the self-hosted workerd platform (`18.171.244.124`).

## Deployment Methods

There are three ways to deploy:

1. **Git push** (recommended) — Push to bare repo on the server
2. **Manual deploy** — Run `workerd-deploy` from your project
3. **SCP + manual restart** — For one-off deployments

## Git Push Deploy

### First-Time Setup

On the server:
```bash
# Create bare git repo
sudo mkdir -p /var/git/my-worker.git
cd /var/git/my-worker.git
sudo git init --bare
sudo git symbolic-ref HEAD refs/heads/main

# Install the post-receive hook
sudo cp /path/to/post-receive hooks/post-receive
sudo sed -i 's/PLACEHOLDER/my-worker/' hooks/post-receive
sudo chmod +x hooks/post-receive

# Set up the worker directory
sudo mkdir -p /etc/workerd/workers/my-worker
echo "8080" | sudo tee /etc/workerd/workers/my-worker/ports

# Generate initial config and start
sudo /usr/local/bin/workerd-gen-config my-worker 8080
sudo /usr/local/bin/workerd-scale up my-worker 8080
```

On your local machine:
```bash
# In your worker project directory
git init
git checkout -b main
git add worker.js manifest.json
git commit -m "initial deploy"
git remote add deploy ssh://deploy@18.171.244.124:/var/git/my-worker.git
git push deploy main
```

On first push, the server must have the `deploy` user's SSH key in `authorized_keys`.

### Subsequent Deploys

```bash
# Make changes to worker.js
git add worker.js
git commit -m "fix: update handler"
git push deploy main
```

The post-receive hook:
1. Checks out `worker.js` to `/etc/workerd/workers/my-worker/`
2. Regenerates configs for all active ports
3. Restarts all instances sequentially (zero-downtime rolling restart)

### Multi-Worker Deploys (Groups)

If your worker depends on other workers in the same group (e.g., `api` depends on `auth` via service binding), include the group workers in the repo:

```
my-project/
  worker.js          ← Main worker (api)
  manifest.json       ← Lists group: ["api", "auth"]
  auth-worker.js      ← Group member worker
```

The post-receive hook checks out `auth-worker.js` alongside `worker.js`:

```bash
# Post-receive hook handles group workers:
if git --git-dir="$GIT_DIR" cat-file -e "$newrev:auth-worker.js" 2>/dev/null; then
    git --git-dir="$GIT_DIR" cat-file blob "$newrev:auth-worker.js" > "$AUTH_DIR/worker.js"
fi
```

### Deploy Script (Alternative)

The `deploy.sh` script uses wrangler to build and push:

```bash
#!/bin/bash
# deploy.sh — run from worker project root
WORKER=${1:-$(basename "$(pwd)")}
SERVER=${WORKERD_SERVER:-"deploy@18.171.244.124"}

# Build with wrangler (dry-run)
wrangler deploy --dry-run --outdir dist

# Push to bare git repo on server
cd dist
git init
git checkout -b main
git add worker.js
git commit -m "deploy $(date -u +%Y%m%dT%H%M%SZ)"
git remote add deploy "ssh://${SERVER}:/var/git/${WORKER}.git" 2>/dev/null || true
git push deploy main --force
```

### Manual SCP

For one-off debugging:
```bash
scp worker.js ubuntu@18.171.244.124:/etc/workerd/workers/my-worker/
ssh ubuntu@18.171.244.124 sudo systemctl restart 'workerd@my-worker:*'
```

## Deploy Checklist

Before deploying, verify:

- [ ] `manifest.json` has correct `name`, `entrypoint`, `compatibilityDate`
- [ ] `group` includes all workers that need to share a process
- [ ] `bindings` match what your worker code expects
- [ ] `env` lists all environment variables used
- [ ] `.env` file exists with values (if using env vars)
- [ ] Worker responds on `/healthz` with `200 OK`
- [ ] Worker compiles: `workerd compile config.capnp` (on server)

## Post-Deploy Verification

```bash
# Check service status
ssh ubuntu@18.171.244.124 systemctl status 'workerd@my-worker:*'

# Check direct port access
curl -s http://18.171.244.124:8080/

# Check via Caddy
curl -s http://18.171.244.124/

# View logs
ssh ubuntu@18.171.244.124 journalctl -u 'workerd@my-worker:*' -n 20

# Verify git log
ssh ubuntu@18.171.244.124 git --git-dir=/var/git/my-worker.git log --oneline
```

## Rollback

```bash
# View git history on server
ssh ubuntu@18.171.244.124 git --git-dir=/var/git/my-worker.git log --oneline

# Checkout a previous commit (reverts worker.js)
# On the server:
cd /etc/workerd/workers/my-worker
sudo git --git-dir=/var/git/my-worker.git checkout <commit-hash> -- worker.js
sudo /usr/local/bin/workerd-gen-config my-worker <port>
sudo systemctl restart 'workerd@my-worker:*'
```

## Environment-Specific Deploys

Use separate worker names for environments:
```bash
# Staging
workerd-scale up my-worker-staging 8081

# Production
workerd-scale up my-worker 8080
```

Or use different ports:
```bash
# Dev on 8080, staging on 8081, prod on 8082
```

## Cron & Scheduled Workers

workerd supports scheduled/cron triggers. Configure in the Cap'n Proto config:
```capnp
services = [
  (name = "main", worker = .mainWorker),
],
sockets = [
  ( name = "http", address = "*:8080", http = (), service = "main" ),
],
timers = [
  ( name = "cleanup", schedule = "0 * * * *", handler = .onSchedule ),
],
```]]>