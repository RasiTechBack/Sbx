#!/usr/bin/env python3
"""Incremental deploy: build artifacts + server code, preserve remote DB/JWT, restart PM2."""

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

SKIP_DIR_NAMES = {".git", "node_modules", "agent-transcripts", ".cursor", "terminals"}
SKIP_FILE_NAMES = {
    "records.json.migrated",
    "records.db",
    "records.db-shm",
    "records.db-wal",
    "records.db.zst",
    "sample.txt",
    "users.json",  # never clobber remote accounts
    "telegram.json",  # preserve remote bot/API credentials
    "telegram-sessions.json",  # preserve linked personal sessions
    "telegram-monitors.json",  # preserve monitor list
    "telegram-monitor-activity.json",  # preserve live series/logs
}
SKIP_NAME_PREFIXES = ("_",)


def connect() -> paramiko.Transport:
    if not PASSWORD:
        raise SystemExit("Set CREDS_SSH_PASS")
    print(f"Connecting {USER}@{HOST}…", flush=True)
    transport = paramiko.Transport((HOST, 22))
    transport.default_window_size = 64 * 1024 * 1024
    transport.default_max_packet_size = 1024 * 1024
    transport.connect(username=USER, password=PASSWORD)
    return transport


def run(transport: paramiko.Transport, cmd: str, check: bool = True) -> str:
    print(f"$ {cmd}", flush=True)
    chan = transport.open_session()
    chan.get_pty()
    chan.exec_command(cmd)
    chunks: list[str] = []
    while True:
        if chan.recv_ready():
            chunk = chan.recv(65536).decode("utf-8", "replace")
            chunks.append(chunk)
            sys.stdout.write(chunk)
            sys.stdout.flush()
        if chan.recv_stderr_ready():
            err = chan.recv_stderr(65536).decode("utf-8", "replace")
            sys.stderr.write(err)
            sys.stderr.flush()
        if chan.exit_status_ready() and not chan.recv_ready() and not chan.recv_stderr_ready():
            break
        time.sleep(0.05)
    code = chan.recv_exit_status()
    out = "".join(chunks)
    if check and code != 0:
        raise RuntimeError(f"Command failed ({code}): {cmd}")
    return out


def ensure_dir(sftp: paramiko.SFTPClient, remote: str) -> None:
    parts = remote.strip("/").split("/")
    cur = ""
    for p in parts:
        cur += "/" + p
        try:
            sftp.stat(cur)
        except FileNotFoundError:
            sftp.mkdir(cur)


def should_upload(path: Path, root: Path) -> bool:
    rel = path.relative_to(root)
    if any(part in SKIP_DIR_NAMES for part in rel.parts):
        return False
    if path.name in SKIP_FILE_NAMES:
        return False
    if path.name.startswith(SKIP_NAME_PREFIXES) and path.suffix in {".py", ".mjs", ".sh"}:
        return False
    if path.name.endswith((".db-wal", ".db-shm", ".migrated", ".zst")):
        return False
    return True


def upload_file(sftp: paramiko.SFTPClient, local: Path, remote: str) -> None:
    size = local.stat().st_size
    print(f"↑ {local.relative_to(ROOT)} ({size / 1024:.1f} KB)", flush=True)
    with open(local, "rb") as rf, sftp.file(remote, "wb") as wf:
        wf.set_pipelined(True)
        while True:
            data = rf.read(4 * 1024 * 1024)
            if not data:
                break
            wf.write(data)


def upload_tree(sftp: paramiko.SFTPClient, local: Path, remote: str) -> None:
    ensure_dir(sftp, remote)
    for item in sorted(local.iterdir(), key=lambda p: p.name):
        if item.name in SKIP_DIR_NAMES:
            continue
        if item.is_dir():
            upload_tree(sftp, item, f"{remote}/{item.name}")
            continue
        if not should_upload(item, ROOT):
            print(f"skip {item.relative_to(ROOT)}", flush=True)
            continue
        upload_file(sftp, item, f"{remote}/{item.name}")


def main() -> None:
    if not (ROOT / "dist" / "index.html").exists():
        raise SystemExit("dist/ missing — run npm run build first")

    transport = connect()
    try:
        run(transport, f"mkdir -p {REMOTE_DIR}/server/data {REMOTE_DIR}/dist/assets")
        sftp = paramiko.SFTPClient.from_transport(transport)
        assert sftp is not None

        for name in [
            "package.json",
            "package-lock.json",
            "docker-compose.yml",
            "ecosystem.config.cjs",
            ".env.example",
            "README.md",
        ]:
            src = ROOT / name
            if src.exists():
                upload_file(sftp, src, f"{REMOTE_DIR}/{name}")

        for folder in ["dist", "public", "server", "scripts"]:
            local = ROOT / folder
            if local.exists():
                upload_tree(sftp, local, f"{REMOTE_DIR}/{folder}")

        sftp.close()

        # Prefer ecosystem (credseek + health guard). Fall back to plain restart.
        run(
            transport,
            f"cd {REMOTE_DIR} && npm install --omit=dev && "
            f"(pm2 startOrReload ecosystem.config.cjs --update-env || pm2 restart credseek --update-env) && "
            f"pm2 save && sleep 10 && pm2 status && "
            f"curl -sS -m 20 http://127.0.0.1:3001/api/health && echo",
            check=False,
        )
        print("\nUpdate deploy complete.", flush=True)
        print(f"Web: http://{HOST}/", flush=True)
    finally:
        transport.close()


if __name__ == "__main__":
    main()
