
set -euo pipefail

echo "==> Installing Node 22 + zstd + nginx"
if ! command -v node >/dev/null 2>&1 || ! node -v | grep -qE 'v(2[2-9]|[3-9][0-9])'; then
  curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
  dnf -y install nodejs
fi
dnf -y install gcc-c++ make nginx zstd || dnf -y install gcc-c++ make nginx

node -v
npm -v
npm install -g pm2

cd /opt/credseek
if [ -f server/data/records.db.zst ]; then
  echo "==> Decompressing records.db.zst"
  zstd -d -f -o server/data/records.db server/data/records.db.zst
  # keep zst as backup or remove to save disk
  rm -f server/data/records.db.zst
fi
ls -lh server/data/ || true

echo "==> npm install"
npm install --omit=dev

JWT="$(openssl rand -hex 24 2>/dev/null || echo credseek-prod-$(date +%s))"
cat > /opt/credseek/ecosystem.config.cjs <<EOF
module.exports = {
  apps: [{
    name: 'credseek',
    cwd: '/opt/credseek',
    script: 'npm',
    args: 'start',
    env: {
      NODE_ENV: 'production',
      PORT: '3001',
      HOST: '0.0.0.0',
      JWT_SECRET: '${JWT}',
    },
    max_memory_restart: '2800M',
  }]
}
EOF

cat > /etc/nginx/conf.d/credseek.conf <<'NGX'
server {
  listen 80 default_server;
  listen [::]:80 default_server;
  server_name _;
  client_max_body_size 100m;

  location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;
  }
}
NGX

rm -f /etc/nginx/conf.d/default.conf || true
nginx -t
systemctl enable nginx
systemctl restart nginx

if command -v firewall-cmd >/dev/null 2>&1; then
  firewall-cmd --permanent --add-service=http || true
  firewall-cmd --permanent --add-port=3001/tcp || true
  firewall-cmd --reload || true
fi

cd /opt/credseek
pm2 delete credseek >/dev/null 2>&1 || true
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup systemd -u root --hp /root | tail -n 1 | bash || true
sleep 3
pm2 status
curl -sS http://127.0.0.1:3001/api/health || true
echo
echo "CredSeek deployed"
