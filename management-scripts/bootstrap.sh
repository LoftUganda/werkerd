#!/bin/bash
# bootstrap.sh — one-time server setup for self-hosted workerd platform
# Run as root on Ubuntu 24.04
set -euo pipefail

echo "========================================="
echo "Self-Hosted workerd Platform Bootstrap"
echo "========================================="
echo ""

# ── 1. Install Node.js ──
echo "→ Installing Node.js 20.x..."
if ! command -v node &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt install -y nodejs
fi
echo "  Node.js: $(node --version)"
echo "  npm:     $(npm --version)"

# ── 2. Install workerd ──
echo "→ Installing workerd..."
if ! command -v workerd &>/dev/null; then
    npm install -g workerd
fi
WORKERD_BIN=$(which workerd)
echo "  workerd: $WORKERD_BIN"
workerd --help 2>&1 | head -3 || true

# Ensure workerd is at /usr/bin/workerd for the service unit
if [ "$WORKERD_BIN" != "/usr/bin/workerd" ]; then
    ln -sf "$WORKERD_BIN" /usr/bin/workerd
    echo "  Symlinked to /usr/bin/workerd"
fi

# ── 3. Install Caddy ──
echo "→ Installing Caddy..."
if ! command -v caddy &>/dev/null; then
    apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      | tee /etc/apt/sources.list.d/caddy-stable.list
    chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    chmod o+r /etc/apt/sources.list.d/caddy-stable.list
    apt update
    apt install -y caddy
fi
echo "  Caddy: $(caddy version)"

# ── 4. Create workerd user ──
echo "→ Creating workerd user..."
if ! id workerd &>/dev/null; then
    useradd -r -s /usr/sbin/nologin workerd
fi
echo "  User: workerd (system, no login)"

# ── 5. Create directories ──
echo "→ Creating directory structure..."
mkdir -p /etc/workerd/workers
mkdir -p /var/lib/workerd/workers
mkdir -p /var/git
mkdir -p /etc/caddy
chown -R workerd:workerd /etc/workerd /var/lib/workerd /var/git
echo "  /etc/workerd/workers/"
echo "  /var/lib/workerd/workers/"
echo "  /var/git/"

# ── 6. Install management scripts ──
echo "→ Installing management scripts..."
SCRIPTS_DIR="/tmp/werkerd-scripts"
if [ -d "$SCRIPTS_DIR" ]; then
    cp "$SCRIPTS_DIR"/workerd-gen-config       /usr/local/bin/
    cp "$SCRIPTS_DIR"/workerd-start             /usr/local/bin/
    cp "$SCRIPTS_DIR"/workerd-scale             /usr/local/bin/
    cp "$SCRIPTS_DIR"/workerd-gen-caddyfile     /usr/local/bin/
    cp "$SCRIPTS_DIR"/deploy.sh                 /usr/local/bin/workerd-deploy
    chmod +x /usr/local/bin/workerd-*
    echo "  Scripts installed to /usr/local/bin/"
else
    echo "  WARNING: $SCRIPTS_DIR not found — skipping script install"
fi

# ── 7. Install systemd unit ──
echo "→ Installing systemd unit..."
if [ -f "$SCRIPTS_DIR/workerd@.service" ]; then
    cp "$SCRIPTS_DIR/workerd@.service" /etc/systemd/system/
    systemctl daemon-reload
    echo "  workerd@.service installed"
else
    echo "  WARNING: service file not found — skipping"
fi

# ── 8. Create deploy user ──
echo "→ Creating deploy user..."
if ! id deploy &>/dev/null; then
    useradd -m -s /bin/bash deploy
fi
mkdir -p /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
touch /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh
echo "  Deploy user: deploy"

# ── 9. Deploy sudoers ──
echo "→ Setting up sudoers..."
cat > /etc/sudoers.d/workerd-deploy << 'SUDOEOF'
deploy ALL=(root) NOPASSWD: /bin/systemctl restart workerd@*
deploy ALL=(root) NOPASSWD: /bin/systemctl start workerd@*
deploy ALL=(root) NOPASSWD: /bin/systemctl stop workerd@*
deploy ALL=(root) NOPASSWD: /bin/systemctl enable workerd@*
deploy ALL=(root) NOPASSWD: /bin/systemctl disable workerd@*
deploy ALL=(root) NOPASSWD: /bin/systemctl daemon-reload
SUDOEOF
chmod 440 /etc/sudoers.d/workerd-deploy
echo "  /etc/sudoers.d/workerd-deploy"

# ── 10. Disable default Caddy server block ──
echo "→ Stopping default Caddy service..."
systemctl stop caddy 2>/dev/null || true
systemctl disable caddy 2>/dev/null || true

echo ""
echo "========================================="
echo "Bootstrap complete!"
echo "========================================="
echo ""
echo "Next steps:"
echo "  1. Deploy a worker: workerd-scale up <name> <port>"
echo "  2. Check status:    systemctl status 'workerd@*'"
echo "  3. View logs:       journalctl -u 'workerd@*' -f"
