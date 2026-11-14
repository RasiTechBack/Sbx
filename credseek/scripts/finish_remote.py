#!/usr/bin/env python3
import os
import sys
import time

import paramiko

HOST = os.environ["CREDS_SSH_HOST"]
USER = os.environ["CREDS_SSH_USER"]
PASSWORD = os.environ["CREDS_SSH_PASS"]


def run(transport: paramiko.Transport, cmd: str, check: bool = True) -> int:
    print(f"$ {cmd}", flush=True)
    chan = transport.open_session()
    chan.get_pty()
    chan.exec_command(cmd)
    while True:
        if chan.recv_ready():
            sys.stdout.write(chan.recv(65536).decode("utf-8", "replace"))
            sys.stdout.flush()
        if chan.recv_stderr_ready():
            sys.stderr.write(chan.recv_stderr(65536).decode("utf-8", "replace"))
            sys.stderr.flush()
        if chan.exit_status_ready() and not chan.recv_ready() and not chan.recv_stderr_ready():
            break
        time.sleep(0.05)
    code = chan.recv_exit_status()
    if check and code != 0:
        raise SystemExit(f"fail {code}: {cmd}")
    return code


def main() -> None:
    transport = paramiko.Transport((HOST, 22))
    transport.connect(username=USER, password=PASSWORD)
    try:
        run(
            transport,
            "sed -i 's/ default_server//g; s/default_server//g' /etc/nginx/nginx.conf /etc/nginx/conf.d/*.conf 2>/dev/null || true",
            check=False,
        )

        nginx_conf = """server {
  listen 80;
  listen [::]:80;
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
"""
        sftp = paramiko.SFTPClient.from_transport(transport)
        assert sftp is not None
        with sftp.file("/etc/nginx/conf.d/credseek.conf", "w") as f:
            f.write(nginx_conf)
        sftp.close()

        run(transport, "nginx -t && systemctl enable nginx && systemctl restart nginx")

        run(
            transport,
            "cd /opt/credseek && JWT=$(openssl rand -hex 24) && "
            "cat > ecosystem.config.cjs <<EOF\n"
            "module.exports = {\n"
            "  apps: [{\n"
            "    name: 'credseek',\n"
            "    cwd: '/opt/credseek',\n"
            "    script: 'npm',\n"
            "    args: 'start',\n"
            "    env: {\n"
            "      NODE_ENV: 'production',\n"
            "      PORT: '3001',\n"
            "      HOST: '0.0.0.0',\n"
            "      JWT_SECRET: '$JWT'\n"
            "    },\n"
            "    max_memory_restart: '2800M'\n"
            "  }]\n"
            "}\n"
            "EOF",
        )
        run(transport, "cd /opt/credseek && pm2 delete credseek >/dev/null 2>&1 || true")
        run(transport, "cd /opt/credseek && pm2 start ecosystem.config.cjs && pm2 save")
        run(transport, "pm2 startup systemd -u root --hp /root | tail -n 1 | bash", check=False)
        run(transport, "sleep 6; pm2 status")
        run(transport, "curl -sS http://127.0.0.1:3001/api/health; echo")
        run(transport, "curl -sS -o /dev/null -w 'http:%{http_code}\\n' http://127.0.0.1/")
        print(f"\nOK: http://{HOST}/", flush=True)
    finally:
        transport.close()


if __name__ == "__main__":
    main()
