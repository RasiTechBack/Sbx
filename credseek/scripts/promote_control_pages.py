#!/usr/bin/env python3
"""Promote Accounts + API Docs to top-level pages. Avoid TDZ on shadowed z (useLocation)."""
from pathlib import Path
import shutil

js_path = Path("/opt/credseek/dist/assets/index-Cl7Hn6gA.js")
# always start from known-good bak
src = Path("/opt/credseek/dist/assets/index-Cl7Hn6gA.js.bak-split-pages")
shutil.copy2(src, js_path)
s = js_path.read_text(encoding="utf-8", errors="ignore")
orig_len = len(s)

def must_replace(old, new, label, count=1):
    global s
    n = s.count(old)
    if n < 1:
        raise SystemExit(f"FAIL {label}: not found")
    if n != count and count == 1:
        print(f"WARN {label}: found {n}, replacing first only")
    s = s.replace(old, new, count if count > 0 else n)
    print(f"OK {label}")

# 0) alias useLocation before Zr so loc=... doesn't hit TDZ on state [z,at]
must_replace(
    "function Zr(){",
    "const useLocZr=z;function Zr(){",
    "useLoc alias",
)

# 1) routes
must_replace(
    "(0,U.jsx)(jt,{path:`/settings`,element:(0,U.jsx)(Qr,{children:(0,U.jsx)(Zr,{})})}),(0,U.jsx)(jt,{path:`*`,element:(0,U.jsx)(At,{to:`/`,replace:!0})})",
    "(0,U.jsx)(jt,{path:`/settings`,element:(0,U.jsx)(Qr,{children:(0,U.jsx)(Zr,{})})}),"
    "(0,U.jsx)(jt,{path:`/accounts`,element:(0,U.jsx)(Qr,{children:(0,U.jsx)(Zr,{})})}),"
    "(0,U.jsx)(jt,{path:`/api-docs`,element:(0,U.jsx)(Qr,{children:(0,U.jsx)(Zr,{})})}),"
    "(0,U.jsx)(jt,{path:`*`,element:(0,U.jsx)(At,{to:`/`,replace:!0})})",
    "routes",
)

# 2) loc via alias (NOT z()) — place with other hooks at start
must_replace(
    "function Zr(){let{user:e,loading:t,setUser:n,logout:r}=Kn(),i=st(),[a,o]=En(),",
    "function Zr(){let{user:e,loading:t,setUser:n,logout:r}=Kn(),i=st(),loc=useLocZr(),[a,o]=En(),",
    "Zr loc",
)

# 3) path-aware tab sync
must_replace(
    "(0,_.useEffect)(()=>{let e=Xr(a.get(`tab`))||`profile`;if(e===`telegram`&&!ot)e=`profile`;if(e===`team`&&!ct)e=`profile`;c(e)},[a,ct,ot]);",
    "(0,_.useEffect)(()=>{"
    "const pathName=loc.pathname;"
    "if(pathName===`/accounts`){if(ct)c(`team`);else i(`/settings`,{replace:!0});return;}"
    "if(pathName===`/api-docs`){c(`docs`);return;}"
    "let e=Xr(a.get(`tab`))||`profile`;"
    "if(e===`team`){i(`/accounts`,{replace:!0});return;}"
    "if(e===`docs`){i(`/api-docs`,{replace:!0});return;}"
    "if(e===`telegram`&&!ot)e=`profile`;"
    "c(e);"
    "},[loc.pathname,a,ct,ot]);",
    "effect",
)

# 4) dt
must_replace(
    "function dt(e){c(e),o(e===`profile`?{}:{tab:e},{replace:!0})}",
    "function dt(e){"
    "if(e===`team`)return void i(`/accounts`);"
    "if(e===`docs`)return void i(`/api-docs`);"
    "c(e),o(e===`profile`?{}:{tab:e},{replace:!0})"
    "}",
    "dt",
)

# 5) remove tiles
must_replace(
    "ct&&e.push({id:`team`,label:`Accounts`,desc:`Approvals & users`}),e.push({id:`docs`,label:`API Docs`,desc:`Endpoint & auth for client`}),e.push({id:`session`,label:`Session`,desc:`Sign out`})",
    "e.push({id:`session`,label:`Session`,desc:`Sign out`})",
    "tiles",
)

# 6) title + breadcrumbs
must_replace(
    "title:s===`team`?`Accounts`:s===`docs`?`API Docs`:`Settings`,breadcrumbs:[{label:`Home`,to:`/dashboard`},{label:`Settings`,to:`/settings`},{label:Lt}]",
    "title:(loc.pathname===`/accounts`||s===`team`)?`Accounts`:(loc.pathname===`/api-docs`||s===`docs`)?`API Docs`:`Settings`,"
    "breadcrumbs:(loc.pathname===`/accounts`||s===`team`)"
    "?[{label:`Home`,to:`/dashboard`},{label:`Accounts`}]"
    ":(loc.pathname===`/api-docs`||s===`docs`)"
    "?[{label:`Home`,to:`/dashboard`},{label:`API Docs`}]"
    ":[{label:`Home`,to:`/dashboard`},{label:`Settings`,to:`/settings`},{label:Lt}]",
    "title/breadcrumbs",
)

# 7) wrap settings nav
call_start = s.find("(0,U.jsx)(`nav`,{className:`settings-nav settings-menu`")
if call_start < 0:
    raise SystemExit("FAIL nav: not found")
args_open = s.find("(", call_start + len("(0,U.jsx)"))
i, depth, in_str, esc, args_end = args_open, 0, None, False, None
while i < len(s):
    ch = s[i]
    if in_str:
        if esc:
            esc = False
        elif ch == "\\":
            esc = True
        elif ch == in_str:
            in_str = None
    else:
        if ch in "`\"'":
            in_str = ch
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                args_end = i + 1
                break
    i += 1
if not args_end:
    raise SystemExit("FAIL nav: args end")
nav = s[call_start:args_end]
if "ut.map" not in nav:
    raise SystemExit("FAIL nav: bad extract")
s = s[:call_start] + "loc.pathname===`/settings`&&" + nav + s[args_end:]
print("OK nav wrap", len(nav))

# 8) sidebar peers
old_side = (
    "(0,U.jsx)(`p`,{className:`nav-header`,children:`Control`}),"
    "(0,U.jsxs)(xn,{to:`/settings`,end:!0,className:({isActive:e})=>`admin-nav__item ${e&&!l.search.includes(`tab=`)?`is-active`:``}`,children:[(0,U.jsx)(er,{name:`settings`}),`Settings`]}),"
    "m&&(0,U.jsxs)(xn,{to:`/settings?tab=team`,className:()=>`admin-nav__item ${l.pathname===`/settings`&&(l.search===`?tab=team`||l.search.includes(`tab=team`))?`is-active`:``}`,children:[(0,U.jsx)(er,{name:`accounts`}),`Accounts`]})"
)
new_side = (
    "(0,U.jsx)(`p`,{className:`nav-header`,children:`Control`}),"
    "(0,U.jsxs)(xn,{to:`/settings`,end:!0,className:({isActive:e})=>`admin-nav__item ${e?`is-active`:``}`,children:[(0,U.jsx)(er,{name:`settings`}),`Settings`]}),"
    "m&&(0,U.jsxs)(xn,{to:`/accounts`,className:({isActive:e})=>`admin-nav__item ${e?`is-active`:``}`,children:[(0,U.jsx)(er,{name:`accounts`}),`Accounts`]}),"
    "(0,U.jsxs)(xn,{to:`/api-docs`,className:({isActive:e})=>`admin-nav__item ${e?`is-active`:``}`,children:[(0,U.jsx)(er,{name:`search`}),`API Docs`]})"
)
must_replace(old_side, new_side, "sidebar")

# 9) manage accounts CTA
must_replace(
    "to:`/settings?tab=team`,children:`Manage accounts`",
    "to:`/accounts`,children:`Manage accounts`",
    "manage accounts cta",
)

def paren_balance(text):
    depth = 0
    in_str = None
    esc = False
    for ch in text:
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == in_str:
                in_str = None
            continue
        if ch in "`\"'":
            in_str = ch
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
    return depth

# bak balance
bak = src.read_text(encoding="utf-8", errors="ignore")
if paren_balance(s) != paren_balance(bak):
    raise SystemExit(f"FAIL paren balance {paren_balance(bak)} -> {paren_balance(s)}")

js_path.write_text(s, encoding="utf-8")
print("WROTE", len(s), "from", orig_len)
print("useLocZr", "const useLocZr=z;function Zr()" in s)
print("loc=useLocZr", "loc=useLocZr()" in s)
print("no loc=z()", "loc=z()" not in s)
print("routes", "path:`/accounts`" in s and "path:`/api-docs`" in s)

# cache bust
html = Path("/opt/credseek/dist/index.html")
t = html.read_text()
import re
nt = re.sub(r"index-Cl7Hn6gA\.js(?:\?v=\d+)?", "index-Cl7Hn6gA.js?v=921", t)
html.write_text(nt)
print("cache bust 921")
