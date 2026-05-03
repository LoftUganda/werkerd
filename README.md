# WERKERD — Self-Hosted Cloudflare Workers

Deploy any Cloudflare Workers project to your own server. Zero config changes, git push deploy, automatic scaling.

---

## Prerequisites

- A server running **Ubuntu 22.04+** (AWS, DigitalOcean, Hetzner, etc.)
- SSH access to an account with **passwordless sudo** (standard on cloud images)
- A domain with DNS A record pointing to your server (`*` wildcard recommended)
- SSH key on your local machine (`~/.ssh/id_ed25519.pub` or similar)

---

## Quickstart

### Step 1 — Bootstrap the server

```bash
# Clone the repo and copy scripts to your server
git clone https://github.com/LoftUganda/werkerd.git /tmp/werkerd
scp -r /tmp/werkerd/management-scripts YOUR_USER@YOUR_SERVER:/tmp/

# Run bootstrap (enter your SSH password when prompted)
ssh YOUR_USER@YOUR_SERVER sudo bash /tmp/management-scripts/bootstrap.sh
```

The SSH user you connect with must have passwordless sudo — standard on AWS Ubuntu, DigitalOcean, Hetzner, etc. Bootstrap installs everything under that same user.

### Step 2 — Add your SSH key

```bash
# Passwordless SSH — no more password prompts
ssh-copy-id -i ~/.ssh/id_ed25519.pub YOUR_USER@YOUR_SERVER

# Or manually:
cat ~/.ssh/id_ed25519.pub | ssh YOUR_USER@YOUR_SERVER 'tee -a ~/.ssh/authorized_keys'
```

Test: `ssh YOUR_USER@YOUR_SERVER echo "ok"` — should print `ok` with no password.

### Step 3 — Point DNS at your server

At your DNS provider, add an **A record**:

```
Host: *
Value: YOUR_SERVER_IP
TTL: 300 (or auto)
```

Wildcard `*` makes all subdomains (`hello.yourdomain.com`, `api.yourdomain.com`, etc.) resolve to your server.

### Step 4 — Create a worker and push

**For a static site (React/Vue/Svelte with vite build):**

```bash
# On server — create bare repo
ssh YOUR_USER@YOUR_SERVER 'git init --bare /var/git/my-site.git'
ssh YOUR_USER@YOUR_SERVER 'git config --file /var/git/my-site.git/config receive.denyCurrentBranch ignore'

# On server — install post-receive hook
ssh YOUR_USER@YOUR_SERVER 'cp /usr/local/bin/post-receive-template /var/git/my-site.git/hooks/post-receive'
ssh YOUR_USER@YOUR_SERVER 'sed -i "s/^WORKER=.*/WORKER=\"my-site\"/" /var/git/my-site.git/hooks/post-receive'
ssh YOUR_USER@YOUR_SERVER 'sed -i "s/^DOMAIN=.*/DOMAIN=\"my-site.yourdomain.com\"/" /var/git/my-site.git/hooks/post-receive'
ssh YOUR_USER@YOUR_SERVER 'sed -i "s/^STATIC=.*/STATIC=\"1\"/" /var/git/my-site.git/hooks/post-receive'
ssh YOUR_USER@YOUR_SERVER 'chmod +x /var/git/my-site.git/hooks/post-receive'

# On local — clone, build, push
git clone https://github.com/YOU/my-site.git
cd my-site
git remote add deploy ssh://YOUR_USER@YOUR_SERVER:/var/git/my-site.git
npm install && npm run build
git add -f dist/ && git commit -m "build" && git push deploy main
```

**For a JavaScript worker (Cloudflare Workers format):**

```bash
# On server — create bare repo
ssh YOUR_USER@YOUR_SERVER 'git init --bare /var/git/hello.git'
ssh YOUR_USER@YOUR_SERVER 'git config --file /var/git/hello.git/config receive.denyCurrentBranch ignore'

# On server — install post-receive hook
ssh YOUR_USER@YOUR_SERVER 'cp /usr/local/bin/post-receive-template /var/git/hello.git/hooks/post-receive'
ssh YOUR_USER@YOUR_SERVER 'sed -i "s/^WORKER=.*/WORKER=\"hello\"/" /var/git/hello.git/hooks/post-receive'
ssh YOUR_USER@YOUR_SERVER 'chmod +x /var/git/hello.git/hooks/post-receive'

# On local — clone and push
git clone https://github.com/YOU/hello-worker.git
cd hello-worker
git remote add deploy ssh://YOUR_USER@YOUR_SERVER:/var/git/hello.git
git push deploy main
```

The worker is live at `http://hello.yourdomain.com/` — nginx routes by hostname.

---

## Using the CLI

For workers with bindings (KV, Durable Objects, WebSockets, etc.):

```bash
# Install CLI
cd werkerd-cli && npm install && npm link

# Deploy
cd ~/my-worker
werkerd deploy --port 8080

# Verify
curl http://hello.localhost/
```

The CLI handles: esbuild bundling, `manifest.json` creation, config generation, service restart.

---

## What You Get

| Feature | Status |
|---------|--------|
| `werkerd deploy` CLI | Workers with KV, DO, WebSockets, env vars |
| Git push deploy | Zero-downtime, automatic |
| Static sites (Cloudflare Pages-style) | nginx serves `dist/` |
| nginx load balancer | ~9% overhead, hostname routing |
| Git-driven scaling | `workerd-scale set <worker> N` |
| systemd socket activation | Auto-restart on crash |

---

## Architecture

```
Browser ──── HTTPS ──── nginx :80 ──── hostname routing
                              │
              ┌───────────────┼───────────────┐
              │               │               │
         hello.yourdomain    api.yourdomain    mysite.yourdomain
              │               │               │
         workerd :8080    workerd :8090    nginx static
              │               │               (dist/ folder)
         (JavaScript)    (JavaScript)
```

---

## Deployment Methods

| Method | Use When |
|--------|----------|
| `werkerd deploy` | JavaScript workers with bindings |
| Git push | CI/CD, static sites, any worker |
| SCP + restart | One-off debugging |

See [docs/deploying.md](docs/deploying.md) for full guide including rollback and secrets.

---

## Troubleshooting

**`Permission denied (publickey)` on git push:**
```bash
ssh-copy-id -i ~/.ssh/id_ed25519.pub YOUR_USER@YOUR_SERVER
```

**nginx 502 Bad Gateway:**
```bash
ssh YOUR_USER@YOUR_SERVER 'curl http://localhost:8080/'
ssh YOUR_USER@YOUR_SERVER 'sudo systemctl reload nginx'
```

**DNS not working:**
```bash
dig hello.yourdomain.com  # should show YOUR_SERVER_IP
curl -H "Host: hello.yourdomain.com" http://YOUR_SERVER_IP/
```

---

## Project Structure

```
werkerd/
├── werkerd-cli/              # npm install && npm link
│   └── lib/
│       ├── deploy.js         # CLI deploy pipeline
│       ├── config-reader.js  # wrangler.jsonc parser
│       └── capnp-gen.js      # Cap'n Proto config generator
├── management-scripts/       # Server setup scripts
│   ├── bootstrap.sh          # Fresh server setup
│   ├── workerd-scale        # Scaling CLI (set|start|stop|list|info)
│   ├── workerd-gen-nginx     # nginx upstream generator
│   ├── workerd-gen-config    # Cap'n Proto config generator
│   ├── workerd-start         # systemd ExecStart wrapper
│   ├── workerd@.service      # systemd template unit
│   └── post-receive          # Git push deploy hook
├── examples/                 # Example workers
└── docs/                     # Full documentation
```

---

## Documentation

| Doc | What It Covers |
|-----|----------------|
| [SKILL.md](docs/SKILL.md) | Complete reference: CLI, schema, troubleshooting |
| [deploying.md](docs/deploying.md) | Git push, CLI, static sites, rollback |
| [scaling.md](docs/scaling.md) | `workerd-scale` commands, git-driven scaling |
| [architecture.md](docs/architecture.md) | System design, network flow, performance |
| [configuration.md](docs/configuration.md) | wrangler.jsonc schema, Cap'n Proto |
| [troubleshooting.md](docs/troubleshooting.md) | All errors and fixes |
| [howto.md](docs/howto.md) | Recipes: Hono, DO, KV, WebSockets |
