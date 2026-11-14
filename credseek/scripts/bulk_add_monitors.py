#!/usr/bin/env python3
"""Bulk-add Telegram channels to CredSeek live monitoring (dedupe by username)."""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get("CREDS_API", "http://202.10.34.119").rstrip("/")
EMAIL = os.environ.get("CREDS_ADMIN_EMAIL", "admin@credseek.local")
PASSWORD = os.environ.get("CREDS_ADMIN_PASSWORD", "admin123")

RAW_LINES = """
https://t.me/FreeLogsChat1
https://t.me/ravenulp
https://t.me/combolistleads
https://t.me/ShinyHuntersLeaks
https://t.me/JUBAsearch2
https://t.me/freshlogsbot
https://t.me/lefousamples
https://t.me/Free_Logss_Cloud
https://t.me/LogsByRedBoss
https://t.me/LOGINTEXT
https://t.me/SatanCloudData
https://t.me/sjdjdjsjsisjshshah
https://t.me/zxc1337test_1337
https://t.me/urluserpass
https://t.me/darkstarfree
https://t.me/freelogcloud
https://t.me/Hacxx_Underground
https://t.me/freelogs1only
https://t.me/cloud_links
https://t.me/logourltxt
https://t.me/ParadiseCloudFree
https://t.me/RichDataCloud
https://t.me/atxxxchannel
https://t.me/LogsByMaxus
https://t.me/LogsZoneFree
https://t.me/senoritacloud
https://t.me/Trident_Logs
https://t.me/undergroundtxt
https://t.me/empcloud
https://t.me/ulp2026
https://t.me/MoonExtraData
https://t.me/EclipseLogsCloud
https://t.me/UsmanFreshData
https://t.me/rezoncloud
https://t.me/bencloud0
https://t.me/TON618_CLOUD_FREE
https://t.me/free_mail_pass_cloud
https://t.me/Everlasting_Logs
https://t.me/txt_cloud
https://t.me/nyarvexxx
https://t.me/DBC15Telegram
https://t.me/FreeVeryLogs
https://t.me/NocturnalLogsFree
https://t.me/TutyFruttiLogs
https://t.me/DaddyRebornData
https://t.me/BlazeFreeLogs
https://t.me/spywarlegh
https://t.me/InfernoTeamLogs
https://t.me/planetsclo
https://t.me/FreeFastLogs
https://t.me/CloudyDataTeam
https://t.me/DmitriyData
https://t.me/HelixDataCloud
https://t.me/HoneyCloudLogs
https://t.me/RRcloudLogs
https://t.me/shadlivel0g
https://t.me/safetylow
https://t.me/LogsByRedBoss
https://t.me/EpilepsyCloudLogs
https://t.me/MagicCloudFree
https://t.me/thedataleaks
https://t.me/LogsByRick
https://t.me/ParadiseCloudFree
https://t.me/LogsByMaxus
https://t.me/MoonExtraData
https://t.me/frankdedfoIders
https://t.me/RedlinePublicCloudFree
https://t.me/BananaCloudFree
https://t.me/osminggame
https://t.me/althecl
https://t.me/ZeroTwoData
https://t.me/Ghostbusterscloud
https://t.me/WebLogsData
https://t.me/ZeroLogsCloud
https://t.me/REDLINEPREMIUMDATA
https://t.me/HunterLogData
https://t.me/GenesisRebornData
https://t.me/maflegs
https://t.me/WarriorFreeCloud
"""

USER_RE = re.compile(r"(?:https?://)?t\.me/([A-Za-z0-9_]+)/?", re.I)


def extract_usernames(text: str) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for line in text.splitlines():
        m = USER_RE.search(line.strip())
        if not m:
            continue
        user = m.group(1)
        key = user.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(user)
    return out


def api(method: str, path: str, token: str | None = None, body: dict | None = None) -> tuple[int, dict]:
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=data,
        method=method,
        headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            raw = res.read().decode("utf-8", "replace")
            return res.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            payload = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            payload = {"error": raw or str(e)}
        return e.code, payload


def main() -> int:
    users = extract_usernames(RAW_LINES)
    print(f"Unique channels: {len(users)}", flush=True)

    code, login = api("POST", "/api/auth/login", body={"email": EMAIL, "password": PASSWORD})
    if code >= 400 or not login.get("token"):
        print(f"Login failed ({code}): {login}", flush=True)
        return 1
    token = str(login["token"])
    print("Logged in.", flush=True)

    code, existing = api("GET", "/api/telegram/monitors", token=token)
    if code >= 400:
        print(f"List monitors failed ({code}): {existing}", flush=True)
        return 1
    monitors = existing.get("monitors") or []
    have = set()
    for m in monitors:
        u = str(m.get("username") or "").lower().lstrip("@")
        if u:
            have.add(u)
        inp = str(m.get("input") or "")
        m2 = USER_RE.search(inp)
        if m2:
            have.add(m2.group(1).lower())
    print(f"Already monitoring: {len(have)}", flush=True)

    added = skipped = failed = 0
    for i, user in enumerate(users, 1):
        if user.lower() in have:
            print(f"[{i}/{len(users)}] skip @{user} (already)", flush=True)
            skipped += 1
            continue
        url = f"https://t.me/{user}"
        print(f"[{i}/{len(users)}] add @{user} …", flush=True)
        code, res = api("POST", "/api/telegram/monitors", token=token, body={"input": url})
        if code in (200, 201):
            title = (res.get("monitor") or {}).get("title") or user
            print(f"  OK → {title}", flush=True)
            have.add(user.lower())
            added += 1
        elif code == 409:
            print(f"  exists: {res.get('error')}", flush=True)
            have.add(user.lower())
            skipped += 1
        else:
            err = res.get("error") or res
            print(f"  FAIL ({code}): {err}", flush=True)
            failed += 1
        # gentle pacing for Telegram resolve/join
        time.sleep(1.2)

    print(
        f"\nDone. added={added} skipped={skipped} failed={failed} total_unique={len(users)}",
        flush=True,
    )
    return 0 if failed == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
