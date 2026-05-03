# Deploying Workers

werkerd supports three deployment methods: CLI deploy, git push, and manual SCP.

## Deployment Methods

| Method | Best For | Zero Downtime |
|--------|----------|---------------|
| `werkerd deploy` (CLI) | JavaScript workers with bindings | Via rolling restart |
| Git push | CI/CD, static sites, any worker | Yes |
| SCP + restart | Debugging, one-off fixes | No |

## CLI Deploy

```bash
cd werkerd-cli && npm install && npm link
cd ~/my-worker
werkerd deploy --port 8080
```

## Git Push Deploy

### One-Time Server Setup

```bash
# SSH to server as the user with sudo access (ubuntu, admin, ec2-user, etc.)
ssh YOUR_USER@YOUR_SERVER

# Run bootstrap (uses whichever user you're connected as)
sudo bash /tmp/management-scripts/bootstrap.sh

# Add your SSH key
cat ~/.ssh/id_ed25519.pub | tee -a ~/.ssh/authorized_keys

# Create bare git repo for your worker
git init --bare /var/git/my-worker.git
```

### Clone and Push

```bash
# On your local machine
git clone https://github.com/YOUR_ORG/my-worker.git
cd my-worker

# Add deploy remote
git remote add deploy ssh://YOUR_USER@YOUR_SERVER:/var/git/my-worker.git

# Build (if needed)
npm install && npm run build

# Force-add dist/ if it's in .gitignore (for static sites)
git add -f dist/

# Push
git push deploy main
```

### How Post-Receive Hook Works

The hook at `/var/git/<worker>.git/hooks/post-receive` handles deployment:

```
git push deploy main
     │
     ▼
post-receive hook
     │
     ├── git checkout dist/ (or worker files)
     ├── [STATIC mode] → nginx serves dist/
     └── [WORKER mode] → workerd serves on port
```

## Static Sites (Cloudflare Pages-style)

For static sites (React, Vue, Svelte apps with `vite build` output):

### Server Setup (once per domain)

```bash
ssh YOUR_USER@YOUR_SERVER

# Create the worker git repo
git init --bare /var/git/my-static.git

# Copy and configure post-receive hook
cp /usr/local/bin/post-receive-template /var/git/my-static.git/hooks/post-receive
sed -i 's/^WORKER=.*/WORKER="my-static"/' /var/git/my-static.git/hooks/post-receive
sed -i 's/^DOMAIN=.*/DOMAIN="myapp.example.com"/' /var/git/my-static.git/hooks/post-receive
sed -i 's/^STATIC=.*/STATIC="1"/' /var/git/my-static.git/hooks/post-receive
chmod +x /var/git/my-static.git/hooks/post-receive
```

### Local Setup

```bash
cd my-static-app
git init && git checkout -b main
npm install && npm run build

# Add dist/ to git (normally ignored)
echo "/dist" >> .gitignore
git add -f dist/   # Force-add because dist/ is in .gitignore

# Or better: include dist/ in a separate commit after build
git add -f dist/ && git commit -m "build output"

git remote add deploy ssh://YOUR_USER@YOUR_SERVER:/var/git/my-static.git
git push deploy main
```

The hook will:
1. Check out `dist/` from git
2. Write nginx config for your domain
3. Reload nginx
4. Your app is live at `http://myapp.example.com`

## JavaScript Workers (workerd)

For Workers with bindings (KV, DO, WebSockets, etc.):

```bash
ssh YOUR_USER@YOUR_SERVER

# Create repo
git init --bare /var/git/my-worker.git
cp /usr/local/bin/post-receive-template /var/git/my-worker.git/hooks/post-receive
sed -i 's/^WORKER=.*/WORKER="my-worker"/' /var/git/my-worker.git/hooks/post-receive
# Keep STATIC unset for worker mode
chmod +x /var/git/my-worker.git/hooks/post-receive

# Pre-create worker directory with scale and ports
mkdir -p /etc/workerd/workers/my-worker
echo "8080" | tee /etc/workerd/workers/my-worker/ports
echo "1" | tee /etc/workerd/workers/my-worker/scale
```

Local push:
```bash
git remote add deploy ssh://YOUR_USER@YOUR_SERVER:/var/git/my-worker.git
git push deploy main
```

## DNS Setup

Point your domain's A record to your server's IP:

```
# At your DNS provider
A记录  @     → YOUR_SERVER_IP
A记录  *     → YOUR_SERVER_IP   # wildcard for subdomains
```

Wait for propagation (5 min - 24 hours), then:
```
curl http://myapp.example.com/
```

## Rollback

```bash
# On server
git -C /var/git/my-worker.git log --oneline

# Checkout old version
cd /etc/workerd/workers/my-worker
git checkout <old-hash> -- worker.js
```

## Checklist

Before deploying:

- [ ] `wrangler.jsonc` has correct `name`, `main`, `compatibility_date`
- [ ] For static sites: `dist/` is built (`npm run build`)
- [ ] `git add -f dist/` done if using static site mode
- [ ] SSH key added to `~/.ssh/authorized_keys` on the SSH user
- [ ] DNS A record points to server IP
- [ ] Post-receive hook installed with correct `WORKER` name
