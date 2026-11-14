#!/usr/bin/env python3
"""Deploy CredSeek to a remote VPS over SSH/SFTP. Password via CREDS_SSH_PASS env."""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import paramiko

HOST = os.environ.get("CREDS_SSH_HOST", "202.10.34.119")
USER = os.environ.get("CREDS_SSH_USER", "root")
PASSWORD = os.environ.get("CREDS_SSH_PASS", "")
REMOTE_DIR = os.environ.get("CREDS_REMOTE_DIR", "/opt/credseek")

ROOT = Path(__file__).resolve().parents[1]

SKIP_DIR_NAMES = {".git", "node_modules", "agent-transcripts", ".cursor", "terminals", "assets", "src"}
SKIP_FILE_NAMES = {
    "records.json.migrated",
    "records.db",  # upload compressed .zst instead
    "records.db-shm",
    "records.db-wal",
    "sample.txt",
}


def connect() -> tuple[paramiko.SSHClient, paramiko.Transport]:
    if not PASSWORD:
        raise SystemExit("Set CREDS_SSH_PASS")
    print(f"Connecting {USER}@{HOST}…", flush=True)
    transport = paramiko.Transport((HOST, 22))
    transport.default_window_size = 64 * 1024 * 1024
    transport.default_max_packet_size = 1024 * 1024
    transport.connect(username=USER, password=PASSWORD)
    client = paramiko.SSHClient()
    client._transport = transport  # type: ignore[attr-defined]
    return client, transport


def run(client: paramiko.SSHClient, cmd: str, check: bool = True) -> str:
    print(f"$ {cmd}", flush=True)
    transport = client.get_transport()
    assert transport is not None
    chan = transport.open_session()
    chan.get_pty()
    chan.exec_command(cmd)
    out_chunks: list[str] = []
    while True:
        if chan.recv_ready():
            chunk = chan.recv(65536).decode("utf-8", errors="replace")
            out_chunks.append(chunk)
            print(chunk, end="", flush=True)
        if chan.recv_stderr_ready():
            err = chan.recv_stderr(65536).decode("utf-8", errors="replace")
            print(err, end="", file=sys.stderr, flush=True)
        if chan.exit_status_ready() and not chan.recv_ready() and not chan.recv_stderr_ready():
            break
        time.sleep(0.05)
    code = chan.recv_exit_status()
    out = "".join(out_chunks)
    if check and code != 0:
        raise RuntimeError(f"Command failed ({code}): {cmd}")
    return out


def ensure_remote_dir(sftp: paramiko.SFTPClient, remote: str) -> None:
    parts = remote.strip("/").split("/")
    cur = ""
    for p in parts:
        cur += "/" + p
        try:
            sftp.stat(cur)
        except FileNotFoundError:
            sftp.mkdir(cur)


def should_upload(path: Path) -> bool:
    rel = path.relative_to(ROOT)
    if any(part in SKIP_DIR_NAMES for part in rel.parts):
        return False
    if path.name in SKIP_FILE_NAMES:
        return False
    if path.name.endswith(".db-wal") or path.name.endswith(".db-shm") or path.name.endswith(".migrated"):
        return False
    return True


def upload_file(sftp: paramiko.SFTPClient, local: Path, remote: str) -> None:
    size = local.stat().st_size
    print(f"↑ {local.relative_to(ROOT)} ({size / (1024 * 1024):.1f} MB)", flush=True)
    last = [time.time()]
    start = time.time()

    def cb(transferred: int, total: int) -> None:
        now = time.time()
        if now - last[0] >= 2 or transferred == total:
            elapsed = max(now - start, 0.001)
            speed = (transferred / (1024 * 1024)) / elapsed
            pct = (transferred / total) * 100 if total else 0
            print(
                f"  … {transferred / (1024 * 1024):.0f}/{total / (1024 * 1024):.0f} MB "
                f"({pct:.1f}%) {speed:.1f} MB/s",
                flush=True,
            )
            last[0] = now

    # larger buffered writes
    with open(local, "rb") as rf, sftp.file(remote, "wb") as wf:
        wf.set_pipelined(True)
        while True:
            data = rf.read(1024 * 1024 * 4)
            if not data:
                break
            wf.write(data)
            # manual progress approx via tell
            cb(rf.tell(), size)
    print(f"  done {size / (1024 * 1024):.1f} MB", flush=True)


def upload_tree(sftp: paramiko.SFTPClient, local: Path, remote: str) -> None:
    ensure_remote_dir(sftp, remote)
    for item in sorted(local.iterdir(), key=lambda p: p.name):
        if item.name in SKIP_DIR_NAMES:
            continue
        if item.is_dir():
            upload_tree(sftp, item, f"{remote}/{item.name}")
            continue
        if not should_upload(item):
            print(f"skip {item.relative_to(ROOT)}", flush=True)
            continue
        upload_file(sftp, item, f"{remote}/{item.name}")


SETUP_SCRIPT = r"""
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
"""


def main() -> None:
    if not (ROOT / "dist").exists():
        raise SystemExit("dist/ missing — run npm run build first")
    zst = ROOT / "server" / "data" / "records.db.zst"
    if not zst.exists():
        raise SystemExit("server/data/records.db.zst missing — compress DB first")

    client, transport = connect()
    try:
        run(client, f"mkdir -p {REMOTE_DIR}/server/data")
        sftp = paramiko.SFTPClient.from_transport(transport)
        assert sftp is not None

        for name in ["package.json", "package-lock.json", "README.md"]:
            src = ROOT / name
            if src.exists():
                upload_file(sftp, src, f"{REMOTE_DIR}/{name}")

        for folder in ["dist", "public", "server"]:
            local = ROOT / folder
            if local.exists():
                upload_tree(sftp, local, f"{REMOTE_DIR}/{folder}")

        with sftp.file(f"{REMOTE_DIR}/_setup.sh", "w") as fh:
            fh.write(SETUP_SCRIPT)
        sftp.close()

        run(client, f"chmod +x {REMOTE_DIR}/_setup.sh && bash {REMOTE_DIR}/_setup.sh")
        print("\nDeploy complete.", flush=True)
        print(f"Web:  http://{HOST}/", flush=True)
        print(f"API:  http://{HOST}/api/health", flush=True)
    finally:
        transport.close()


if __name__ == "__main__":
    main()
