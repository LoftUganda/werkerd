#!/bin/bash
# bootstrap.sh — one-time server setup for self-hosted workerd platform
#
# Usage:
#   git clone https://github.com/LoftUganda/werkerd.git /tmp/werkerd
#   scp -r /tmp/werkerd/management-scripts YOUR_USER@YOUR_SERVER:/tmp/
#   ssh YOUR_USER@YOUR_SERVER sudo bash /tmp/management-scripts/bootstrap.sh
#
# The SSH user you connect with must have passwordless sudo (standard on
# AWS Ubuntu, DigitalOcean, Hetzner, etc.). The bootstrap script itself
# uses that same user for all operations — no new users are created.
set -euo pipefail

# ── Detect SSH user (the user we connected as before sudo) ──────────────────────
# When running via `ssh user@host sudo bash script.sh`, SUDO_USER = original user
SSH_USER="${SUDO_USER:-${1:-}}"
if [ -z "$SSH_USER" ]; then
    SSH_USER=$(logname 2>/dev/null) || SSH_USER=$(whoami)
fi

# If already root (or the SSH user IS root), no sudo needed; otherwise use sudo
if [ "$(id -u)" = "0" ]; then
    SUDO=""
elif [ "$SSH_USER" = "root" ]; then
    SUDO=""
else
    SUDO="sudo"
fi

# The SSH user — directories are chowned to this user so they can write
CURRENT_USER="$SSH_USER"

echo "========================================="
echo "Self-Hosted workerd Platform Bootstrap"
echo "========================================="
echo "  SSH user: $CURRENT_USER"
echo ""

# ── 1. Fix locale warnings ──
echo "→ Configuring locale..."
$SUDO apt-get update -qq 2>/dev/null || true
$SUDO apt-get install -y -qq language-pack-en 2>/dev/null || true
echo 'LANG=en_US.UTF-8' | $SUDO tee /etc/default/locale > /dev/null 2>&1 || true

# ── 2. Install Node.js ──
echo "→ Installing Node.js 20.x..."
if ! command -v node &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO bash - 2>/dev/null || true
    $SUDO apt-get install -y nodejs 2>/dev/null || true
fi
echo "  Node.js: $(node --version 2>/dev/null || echo 'not found')"

# ── 3. Install workerd ──
echo "→ Installing workerd..."
if ! command -v workerd &>/dev/null; then
    npm install -g workerd 2>/dev/null || true
fi
if command -v workerd &>/dev/null; then
    WORKERD_BIN=$(which workerd)
    [ "$WORKERD_BIN" != "/usr/bin/workerd" ] && $SUDO ln -sf "$WORKERD_BIN" /usr/bin/workerd
    echo "  workerd: /usr/bin/workerd"
fi

# ── 4. Install nginx ──
echo "→ Installing nginx..."
if ! command -v nginx &>/dev/null; then
    $SUDO apt-get update -qq 2>/dev/null || true
    $SUDO apt-get install -y nginx 2>/dev/null || true
fi
echo "  nginx: $(nginx -v 2>&1 | grep -o '[0-9.]*$')"

# ── 5. Create workerd system user ──
echo "→ Creating workerd system user..."
$SUDO useradd -r -s /usr/sbin/nologin workerd 2>/dev/null || true
echo "  User: workerd (system, no-login, used for workerd processes only)"

# ── 6. Create directories ──
echo "→ Creating directory structure..."
$SUDO mkdir -p /etc/workerd/workers
$SUDO mkdir -p /var/lib/workerd/workers
$SUDO mkdir -p /var/git
$SUDO mkdir -p /etc/nginx/sites-available
$SUDO mkdir -p /etc/nginx/sites-enabled
$SUDO mkdir -p /var/log/nginx
$SUDO chown -R workerd:workerd /etc/workerd /var/lib/workerd 2>/dev/null || true
$SUDO chown -R www-data:www-data /var/log/nginx 2>/dev/null || true
echo "  Directories created"

# ── 7. Write main nginx.conf ──
echo "→ Writing nginx.conf..."
$SUDO tee /etc/nginx/nginx.conf > /dev/null << 'NginxConf'
user www-data;
worker_processes auto;
worker_cpu_affinity auto;
worker_rlimit_nofile 65535;
error_log /var/log/nginx/error.log;
pid /run/nginx.pid;

events {
    worker_connections 65535;
    multi_accept on;
    accept_mutex on;
    use epoll;
}

http {
    server_tokens off;
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    log_format workerd '$remote_addr - $remote_user [$time_local] "$request" '
                      '$status $body_bytes_sent "$http_referer" '
                      '"$http_user_agent" $request_time upstream_addr $upstream_addr';
    access_log /var/log/nginx/workerd-access.log workerd;
    error_log /var/log/nginx/workerd-error.log;

    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout 65;
    keepalive_requests 10000;

    client_max_body_size 10m;
    client_body_buffer_size 128k;
    client_header_buffer_size 1k;
    large_client_header_buffers 4 8k;
    client_body_timeout 12;
    client_header_timeout 12;
    send_timeout 10;

    proxy_buffer_size 128k;
    proxy_buffers 8 256k;
    proxy_busy_buffers_size 256k;
    proxy_connect_timeout 5s;
    proxy_send_timeout 30s;
    proxy_read_timeout 30s;

    gzip on;
    gzip_vary on;
    gzip_min_length 256;
    gzip_proxied any;
    gzip_types text/plain application/json application/javascript text/css;
    gzip_comp_level 4;

    open_file_cache max=1000 inactive=20s;
    open_file_cache_valid 30s;
    open_file_cache_min_uses 2;
    open_file_cache_errors on;

    include /etc/nginx/sites-enabled/*;
}
NginxConf
echo "  nginx.conf written"

# ── 8. Install management scripts ──
echo "→ Installing management scripts..."
SCRIPTS_DIR="${HOME}/.werkerd-scripts"
[ -d /tmp/management-scripts ] && SCRIPTS_DIR="/tmp/management-scripts"

# Fallback: clone repo if scripts dir not found (handles curl-pipe bootstrap)
if [ ! -d "$SCRIPTS_DIR" ]; then
    echo "  Scripts dir not found — cloning werkerd repo..."
    CLONE_DIR=$(mktemp -d)
    git clone --depth 1 https://github.com/LoftUganda/werkerd.git "$CLONE_DIR" 2>/dev/null || true
    if [ -d "$CLONE_DIR/management-scripts" ]; then
        SCRIPTS_DIR="$CLONE_DIR/management-scripts"
        echo "  Cloned to $SCRIPTS_DIR"
    fi
fi

if [ -d "$SCRIPTS_DIR" ]; then
    $SUDO cp "$SCRIPTS_DIR"/workerd-gen-config    /usr/local/bin/
    $SUDO cp "$SCRIPTS_DIR"/workerd-start         /usr/local/bin/
    $SUDO cp "$SCRIPTS_DIR"/workerd-scale         /usr/local/bin/
    $SUDO cp "$SCRIPTS_DIR"/workerd-gen-nginx     /usr/local/bin/
    $SUDO cp "$SCRIPTS_DIR"/workerd@.service      /usr/local/bin/
    $SUDO cp "$SCRIPTS_DIR"/post-receive          /usr/local/bin/post-receive-template
    chmod +x /usr/local/bin/workerd-* 2>/dev/null || true
    chmod +x /usr/local/bin/post-receive-template 2>/dev/null || true
    # Make scripts writable by current user (cloned files are root-owned)
    $SUDO chown "$CURRENT_USER:$CURRENT_USER" /usr/local/bin/post-receive-template
    echo "  Scripts installed to /usr/local/bin/"
else
    echo "  WARNING: scripts not found"
fi

# ── 9. Install systemd unit ──
echo "→ Installing systemd unit..."
if [ -f /usr/local/bin/workerd@.service ]; then
    $SUDO cp /usr/local/bin/workerd@.service /etc/systemd/system/
    $SUDO systemctl daemon-reload
    echo "  workerd@.service installed"
fi

# ── 10. Setup nginx site ──
echo "→ Setting up nginx..."
$SUDO rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true

# Make dirs writable by current user so post-receive hook can write configs
$SUDO chown -R "$CURRENT_USER:$CURRENT_USER" /etc/nginx/sites-available
$SUDO chown -R "$CURRENT_USER:$CURRENT_USER" /etc/nginx/sites-enabled
$SUDO chown -R "$CURRENT_USER:$CURRENT_USER" /var/git
$SUDO chown -R "$CURRENT_USER:$CURRENT_USER" /etc/workerd/workers

if command -v workerd-gen-nginx &>/dev/null; then
    # Remove stale root-owned config so we can regenerate as current user
    $SUDO rm -f /etc/nginx/sites-available/workerd
    workerd-gen-nginx 2>/dev/null || true
    $SUDO chown "$CURRENT_USER:$CURRENT_USER" /etc/nginx/sites-available/workerd
fi

$SUDO ln -sf /etc/nginx/sites-available/workerd /etc/nginx/sites-enabled/workerd
echo "  nginx sites configured"

# ── 11. Git safe directory ──
echo "→ Configuring git..."
git config --global --add safe.directory '*' 2>/dev/null || true
git config --global init.defaultBranch main 2>/dev/null || true
echo "  Git configured"

# ── 12. Start nginx ──
echo "→ Starting nginx..."
if $SUDO nginx -t; then
    $SUDO systemctl enable nginx
    $SUDO systemctl restart nginx
    echo "  nginx: active"
else
    echo "  ERROR: nginx config invalid"
fi

# ── 13. Enable TCP BBR ──
echo "→ Enabling TCP BBR..."
if sysctl net.ipv4.tcp_congestion_control 2>/dev/null | grep -q bbr; then
    echo "  BBR already enabled"
else
    echo "net.ipv4.tcp_congestion_control = bbr" | $SUDO tee -a /etc/sysctl.d/99-bbr.conf > /dev/null || true
    echo "net.ipv4.tcp_fastopen = 3" | $SUDO tee -a /etc/sysctl.d/99-bbr.conf > /dev/null || true
    $SUDO sysctl -p /etc/sysctl.d/99-bbr.conf 2>/dev/null || true
    echo "  BBR enabled"
fi

echo ""
echo "========================================="
echo "Bootstrap complete!"
echo "========================================="
echo ""
echo "Next steps:"
echo ""
echo "  1. Add your SSH key (so you can push without password):"
echo "     ssh-copy-id -i ~/.ssh/id_ed25519.pub \$USER@YOUR_SERVER"
echo "     # Or: cat ~/.ssh/id_ed25519.pub | ssh \$USER@YOUR_SERVER 'tee -a ~/.ssh/authorized_keys'"
echo ""
echo "  2. Create a worker git repo on the server:"
echo "     ssh \$USER@YOUR_SERVER 'git init --bare /var/git/my-worker.git'"
echo ""
echo "  3. Clone, add remote, push:"
echo "     git clone https://github.com/YOU/my-worker.git"
echo "     cd my-worker"
echo "     git remote add deploy ssh://\$USER@YOUR_SERVER:/var/git/my-worker.git"
echo "     git push deploy main"
echo ""
echo "See README.md for full guide."
