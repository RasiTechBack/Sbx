#!/usr/bin/env python3
"""Upload missing dist/assets and patched server, then restart PM2."""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import paramiko

HOST = os.environ["CREDS_SSH_HOST"]
USER = os.environ["CREDS_SSH_USER"]
PASSWORD = os.environ["CREDS_SSH_PASS"]
ROOT = Path(__file__).resolve().parents[1]


def run(transport: paramiko.Transport, cmd: str, check: bool = True) -> None:
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


def ensure_dir(sftp: paramiko.SFTPClient, remote: str) -> None:
    parts = remote.strip("/").split("/")
    cur = ""
    for p in parts:
        cur += "/" + p
        try:
            sftp.stat(cur)
        except FileNotFoundError:
            sftp.mkdir(cur)


def main() -> None:
    transport = paramiko.Transport((HOST, 22))
    transport.default_window_size = 64 * 1024 * 1024
    transport.connect(username=USER, password=PASSWORD)
    try:
        sftp = paramiko.SFTPClient.from_transport(transport)
        assert sftp is not None

        ensure_dir(sftp, "/opt/credseek/dist/assets")
        assets = ROOT / "dist" / "assets"
        for f in assets.iterdir():
            if not f.is_file():
                continue
            remote = f"/opt/credseek/dist/assets/{f.name}"
            print(f"↑ {f.name} ({f.stat().st_size} bytes)", flush=True)
            sftp.put(str(f), remote)

        print("↑ server/index.ts", flush=True)
        sftp.put(str(ROOT / "server" / "index.ts"), "/opt/credseek/server/index.ts")
        sftp.close()

        run(transport, "ls -lah /opt/credseek/dist/assets")
        run(transport, "pm2 restart credseek && sleep 3 && pm2 status")
        run(
            transport,
            "curl -sS -o /dev/null -w 'js:%{http_code} type:%{content_type}\\n' "
            "http://127.0.0.1:3001/assets/index-D9E9fv7D.js; "
            "curl -sS -o /dev/null -w 'css:%{http_code} type:%{content_type}\\n' "
            "http://127.0.0.1:3001/assets/index-CMhL6ehF.css; "
            "curl -sS http://127.0.0.1:3001/api/health; echo",
        )
        print("Fixed. Open http://%s/" % HOST, flush=True)
    finally:
        transport.close()


if __name__ == "__main__":
    main()
