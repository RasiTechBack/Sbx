#!/usr/bin/env bash
# Patch NGINX2Root (CVE-2026-123007 family) + restart CredSeek.
# Fixed OSS builds: 1.30.7+ (stable) / 1.31.9+ (mainline). Restart required (reload is not enough).
# Also hardens against the unpatched SCTP LPE chain used in "nginx2root".
set -euo pipefail

need_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    echo "Run as root" >&2
    exit 1
  fi
}

version_ge() {
  # semver-ish compare: returns 0 if $1 >= $2
  printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1 | grep -qx "$2"
}

nginx_ver() {
  nginx -v 2>&1 | sed -n 's/.*nginx\///p' | tr -d '\r'
}

install_nginx_org_stable() {
  . /etc/os-release
  local ver="${VERSION_ID%%.*}"
  local releasever="${ver:-9}"
  cat >/etc/yum.repos.d/nginx.repo <<EOF
[nginx-stable]
name=nginx stable repo
baseurl=http://nginx.org/packages/centos/${releasever}/\$basearch/
gpgcheck=1
enabled=1
gpgkey=https://nginx.org/keys/nginx_signing.key
module_hotfixes=true
EOF
  dnf -y remove nginx || true
  dnf -y install nginx
}

harden_sctp() {
  mkdir -p /etc/modprobe.d
  cat >/etc/modprobe.d/disable-sctp.conf <<'EOF'
# Mitigate unpatched SCTP LPE chained with NGINX2Root — refuse autoload.
install sctp /bin/false
blacklist sctp
EOF
  if lsmod | grep -q '^sctp\b'; then
    rmmod sctp 2>/dev/null || modprobe -r sctp 2>/dev/null || true
  fi
  echo "SCTP autoload blocked"
}

ensure_credseek_nginx_conf() {
  mkdir -p /etc/nginx/conf.d
  # Keep HTTP/1.1 reverse-proxy only (no http2/http3/mail) — reduces attack surface.
  cat >/etc/nginx/conf.d/credseek.conf <<'NGX'
server {
  listen 80 default_server;
  listen [::]:80 default_server;
  server_name _;
  client_max_body_size 100m;

  # Do not enable http2/http3 on this vhost until binary is confirmed patched.
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
  # Strip http2 flags if any other snippets added them.
  sed -i -E 's/ http2//g; s/listen ([^;]+) quic;/\# listen \1 quic;/g' \
    /etc/nginx/nginx.conf /etc/nginx/conf.d/*.conf 2>/dev/null || true
}

restart_credseek() {
  if command -v pm2 >/dev/null 2>&1; then
    cd /opt/credseek
    pm2 restart credseek --update-env || pm2 start ecosystem.config.cjs || pm2 start npm --name credseek -- start
    pm2 save || true
    pm2 list
  fi
}

main() {
  need_root
  echo "==> Current nginx: $(nginx -v 2>&1 || echo missing)"
  harden_sctp

  local cur=""
  if command -v nginx >/dev/null 2>&1; then
    cur="$(nginx_ver)"
  fi

  if [[ -n "$cur" ]] && version_ge "$cur" "1.30.7"; then
    echo "==> nginx $cur already >= 1.30.7"
  else
    echo "==> Upgrading nginx via nginx.org stable (need >= 1.30.7)"
    if command -v dnf >/dev/null 2>&1; then
      install_nginx_org_stable
    elif command -v apt-get >/dev/null 2>&1; then
      apt-get update -y
      apt-get install -y curl gnupg2 ca-certificates lsb-release
      curl -fsSL https://nginx.org/keys/nginx_signing.key | gpg --dearmor -o /usr/share/keyrings/nginx-archive-keyring.gpg
      echo "deb [signed-by=/usr/share/keyrings/nginx-archive-keyring.gpg] http://nginx.org/packages/ubuntu $(lsb_release -cs) nginx" \
        >/etc/apt/sources.list.d/nginx.list
      apt-get update -y
      apt-get install -y nginx
    else
      echo "Unsupported package manager" >&2
      exit 1
    fi
  fi

  ensure_credseek_nginx_conf
  nginx -t
  # Full restart replaces the binary — reload is NOT enough for NGINX2Root.
  systemctl enable nginx
  systemctl restart nginx
  echo "==> nginx now: $(nginx -v 2>&1)"
  nginx -v 2>&1 | grep -E '1\.(30\.[7-9]|30\.[1-9][0-9]|3[1-9]\.|[4-9]\.)' >/dev/null \
    || echo "WARN: verify binary is >= 1.30.7 / 1.31.9" >&2

  echo "==> Restarting CredSeek"
  restart_credseek

  sleep 2
  curl -s -o /dev/null -w "local_nginx:%{http_code}\n" --max-time 10 http://127.0.0.1/ || true
  curl -s -o /dev/null -w "local_app:%{http_code}\n" --max-time 10 http://127.0.0.1:3001/ || true
  echo "DONE"
}

main "$@"
