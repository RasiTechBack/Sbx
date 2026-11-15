#!/usr/bin/env python3
"""Fix Account settings label, solo layout width, Accounts/docs copy, cache bust."""
from pathlib import Path
import re
import shutil

js_path = Path("/opt/credseek/dist/assets/index-Cl7Hn6gA.js")
css_path = Path("/opt/credseek/dist/assets/index-BjooqWl7.css")
html_path = Path("/opt/credseek/dist/index.html")
subscribe_path = Path("/opt/credseek/public/subscribe.html")

shutil.copy2(js_path, str(js_path) + ".bak-ux-polish")
shutil.copy2(css_path, str(css_path) + ".bak-ux-polish")

js = js_path.read_text(encoding="utf-8", errors="ignore")
css = css_path.read_text(encoding="utf-8", errors="ignore")

def must_replace(text, old, new, label, count=1):
    n = text.count(old)
    if n < 1:
        raise SystemExit(f"FAIL {label}: not found\n  {old[:120]!r}")
    if count == 1 and n > 1:
        print(f"WARN {label}: found {n}, replacing first")
    text = text.replace(old, new, count)
    print(f"OK {label}")
    return text

# 1) Quick action label
js = must_replace(
    js,
    "to:`/settings`,children:`Account settings`",
    "to:`/settings`,children:`Profile settings`",
    "quick action label",
)

# 2) settings-shell solo class when not on /settings
js = must_replace(
    js,
    "className:`settings-shell`,children:[loc.pathname===`/settings`&&",
    "className:`settings-shell${loc.pathname===`/settings`?``:` settings-shell--solo`}`,children:[loc.pathname===`/settings`&&",
    "shell solo class",
)

# 3) Accounts page copy → consistent English
replacements = [
    (
        "Create users, assign roles, reset passwords. Pakai Trial days saat buat akun.",
        "Create users, assign roles, reset passwords. Use Trial days when creating an account.",
        "accounts subtitle",
    ),
    (
        "User mengirim sendiri ke support@rasitech.org via email client. Approve di sini setelah Anda verifikasi pengajuan.",
        "Users email support@rasitech.org from their mail client. Approve here after you verify the request.",
        "registrations help",
    ),
    (
        "Tidak ada pengajuan menunggu.",
        "No pending registrations.",
        "empty registrations",
    ),
    (
        "Add a new user for search, import, or admin access.",
        "Add a new user for search, import, or admin access.",
        "create help skip",  # identical - skip via special
    ),
    (
        "Untuk uji coba client: set Role=user lalu isi Trial days (>0).",
        "For client trial: set Role=user and Trial days (>0).",
        "trial hint",
    ),
    (
        "`Trial days (opsional)`",
        "`Trial days (optional)`",
        "trial label",
    ),
    (
        "Isi >0 untuk user trial (contoh 7). 0 = tanpa paket.",
        "Set >0 for a trial user (e.g. 7). 0 = no plan.",
        "trial field hint",
    ),
    (
        "Di UI: Settings → Accounts (Trial days / Set trial)",
        "In the app: Accounts → Trial days / Set trial",
        "docs admin path",
    ),
    (
        "prompt(`Trial days untuk ${t}`,`7`)",
        "prompt(`Trial days for ${t}`,`7`)",
        "trial prompt",
    ),
    (
        "x(`Trial ${r} hari aktif: ${t}`)",
        "x(`Trial ${r} days active: ${t}`)",
        "trial success",
    ),
    (
        "`Gagal set trial`",
        "`Failed to set trial`",
        "trial fail",
    ),
]

for old, new, label in replacements:
    if old == new or label.endswith("skip"):
        print(f"SKIP {label}")
        continue
    if old not in js:
        # try without exact match - soft fail for optional
        print(f"MISS {label}: {old[:60]!r}")
        continue
    js = must_replace(js, old, new, label)

# 4) CSS solo layout
if ".settings-shell--solo" not in css:
    # append after first .settings-shell rule
    needle = ".settings-shell{grid-template-columns:210px minmax(0,1fr);align-items:start;gap:16px;width:100%;display:grid}"
    if needle not in css:
        raise SystemExit("FAIL css settings-shell rule not found")
    css = css.replace(
        needle,
        needle + ".settings-shell--solo{grid-template-columns:minmax(0,1fr)}",
        1,
    )
    print("OK css solo")
else:
    print("OK css solo already")

# Also widen muted max-width on accounts/docs cards a bit when solo
if ".settings-shell--solo .settings-card__head .muted" not in css:
    css += ".settings-shell--solo .settings-card__head .muted{max-width:80ch}.settings-shell--solo .settings-content{width:100%;max-width:1100px}"
    print("OK css content width")

js_path.write_text(js, encoding="utf-8")
css_path.write_text(css, encoding="utf-8")

# 5) subscribe.html link
if subscribe_path.exists():
    sub = subscribe_path.read_text(encoding="utf-8", errors="ignore")
    if 'href="/settings?tab=team"' in sub:
        sub = sub.replace('href="/settings?tab=team"', 'href="/accounts"', 1)
        subscribe_path.write_text(sub, encoding="utf-8")
        print("OK subscribe link")
    else:
        print("SKIP subscribe already fixed or missing")

# 6) cache bust
html = html_path.read_text(encoding="utf-8")
html2 = re.sub(r"index-Cl7Hn6gA\.js(?:\?v=\d+)?", "index-Cl7Hn6gA.js?v=922", html)
html2 = re.sub(r"index-BjooqWl7\.css(?:\?v=\d+)?", "index-BjooqWl7.css?v=922", html2)
# if css has no query yet
if "index-BjooqWl7.css?v=922" not in html2 and "index-BjooqWl7.css" in html2:
    html2 = html2.replace("index-BjooqWl7.css", "index-BjooqWl7.css?v=922", 1)
html_path.write_text(html2, encoding="utf-8")
print("OK cache bust 922")

print("DONE")
print("shell--solo in js", "settings-shell--solo" in js)
print("Profile settings", "Profile settings" in js)
print("Account settings left", js.count("Account settings"))
