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

if [ "$WORKERD_BIN" != "/usr/bin/workerd" ]; then
    ln -sf "$WORKERD_BIN" /usr/bin/workerd
    echo "  Symlinked to /usr/bin/workerd"
fi

# ── 3. Install nginx ──
echo "→ Installing nginx..."
if ! command -v nginx &>/dev/null; then
    apt update
    apt install -y nginx
fi
echo "  nginx: $(nginx -v 2>&1)"

# ── 4. Create workerd user ──
echo "→ Creating workerd user..."
if ! id workerd &>/dev/null; then
    useradd -r -s /usr/sbin/nologin workerd
fi
echo "  User: workerd (system, no-login)"

# ── 5. Create directories ──
echo "→ Creating directory structure..."
mkdir -p /etc/workerd/workers
mkdir -p /var/lib/workerd/workers
mkdir -p /var/git
mkdir -p /etc/nginx/sites-available
mkdir -p /etc/nginx/sites-enabled
mkdir -p /var/log/nginx
chown -R workerd:workerd /etc/workerd /var/lib/workerd /var/git
chown -R www-data:www-data /var/log/nginx
echo "  /etc/workerd/workers/"
echo "  /var/lib/workerd/workers/"
echo "  /var/git/"
echo "  /etc/nginx/sites-available/"

# ── 6. Write main nginx.conf ──
echo "→ Writing nginx.conf..."
cat > /etc/nginx/nginx.conf << 'NginxConf'
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

# ── 7. Install management scripts ──
echo "→ Installing management scripts..."
SCRIPTS_DIR="/tmp/werkerd-scripts"
if [ -d "$SCRIPTS_DIR" ]; then
    cp "$SCRIPTS_DIR"/workerd-gen-config       /usr/local/bin/
    cp "$SCRIPTS_DIR"/workerd-start            /usr/local/bin/
    cp "$SCRIPTS_DIR"/workerd-scale             /usr/local/bin/
    cp "$SCRIPTS_DIR"/workerd-gen-nginx        /usr/local/bin/
    cp "$SCRIPTS_DIR"/deploy.sh                 /usr/local/bin/workerd-deploy
    chmod +x /usr/local/bin/workerd-*
    chmod +x /usr/local/bin/workerd-deploy
    echo "  Scripts installed to /usr/local/bin/"
else
    echo "  WARNING: $SCRIPTS_DIR not found — skipping script install"
fi

# ── 8. Install systemd unit ──
echo "→ Installing systemd unit..."
if [ -f "$SCRIPTS_DIR/workerd@.service" ]; then
    cp "$SCRIPTS_DIR/workerd@.service" /etc/systemd/system/
    systemctl daemon-reload
    echo "  workerd@.service installed"
else
    echo "  WARNING: service file not found — skipping"
fi

# ── 9. Setup nginx site ──
echo "→ Setting up nginx..."
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true

if command -v workerd-gen-nginx &>/dev/null; then
    workerd-gen-nginx
fi

if [ -f /etc/nginx/sites-available/workerd ]; then
    ln -sf /etc/nginx/sites-available/workerd /etc/nginx/sites-enabled/workerd
fi

# ── 10. Create deploy user ──
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

# ── 11. Deploy sudoers ──
echo "→ Setting up sudoers..."
cat > /etc/sudoers.d/workerd-deploy << 'SUDOEOF'
deploy ALL=(root) NOPASSWD: /bin/systemctl restart workerd@*
deploy ALL=(root) NOPASSWD: /bin/systemctl start workerd@*
deploy ALL=(root) NOPASSWD: /bin/systemctl stop workerd@*
deploy ALL=(root) NOPASSWD: /bin/systemctl enable workerd@*
deploy ALL=(root) NOPASSWD: /bin/systemctl disable workerd@*
deploy ALL=(root) NOPASSWD: /bin/systemctl daemon-reload
deploy ALL=(root) NOPASSWD: /usr/sbin/nginx
deploy ALL=(root) NOPASSWD: /usr/sbin/nginx -t
deploy ALL=(root) NOPASSWD: /usr/sbin/nginx -s reload
SUDOEOF
chmod 440 /etc/sudoers.d/workerd-deploy
echo "  /etc/sudoers.d/workerd-deploy"

# ── 12. Stop caddy ──
echo "→ Stopping Caddy..."
systemctl stop caddy 2>/dev/null || true
systemctl disable caddy 2>/dev/null || true

# ── 13. Start nginx ──
echo "→ Starting nginx..."
nginx -t && systemctl enable nginx && systemctl restart nginx
echo "  nginx: $(systemctl is-active nginx)"

# ── 14. Enable TCP BBR ──
echo "→ Enabling TCP BBR..."
if sysctl net.ipv4.tcp_congestion_control 2>/dev/null | grep -q bbr; then
    echo "  BBR already enabled"
else
    echo "net.ipv4.tcp_congestion_control = bbr" >> /etc/sysctl.d/99-bbr.conf 2>/dev/null || true
    echo "net.ipv4.tcp_fastopen = 3" >> /etc/sysctl.d/99-bbr.conf 2>/dev/null || true
    sysctl -p /etc/sysctl.d/99-bbr.conf 2>/dev/null || true
    echo "  BBR enabled"
fi

echo ""
echo "========================================="
echo "Bootstrap complete!"
echo "========================================="
echo ""
echo "Next steps:"
echo "  1. Deploy a worker: workerd-scale up <name> <port>"
echo "  2. Check status:    systemctl status 'workerd@*'"
echo "  3. View logs:       journalctl -u 'workerd@*' -f"
echo "  4. Reload nginx:    systemctl reload nginx"