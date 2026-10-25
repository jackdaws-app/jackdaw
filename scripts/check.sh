#!/usr/bin/env bash
# The mechanical checks, in one place so CI and a contributor's laptop cannot
# drift apart. CI calls this file; `npm test` calls this file. Nothing here
# judges design, motion, or copy — those are review's job, and CONVENTIONS.md
# is what they are judged against. A green run means the files parse.
#
# Every check runs even after one fails, because a contributor who has to
# re-run to discover the second error will fix one thing and push.

set -uo pipefail
cd "$(dirname "$0")/.."

fail=0

# In Actions, emit the workflow-command form so a failure annotates the file in
# the diff. Locally that syntax is noise, so it is left off.
annotate() {
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    echo "::error file=$1::$2"
  fi
}

echo "==> Convex types (tsc --noEmit)"
if ! npx tsc --noEmit; then
  annotate "convex" "type error"
  fail=1
fi

echo "==> Extension syntax (node --check)"
# extension/ is no-build vanilla JS that never passes through a bundler, so a
# syntax error reaches the shopper. background.js and config.js are ES modules
# (the manifest declares the service worker as type: module); the rest are
# classic scripts, and node only applies module parsing to .mjs — so checking a
# classic script as a module would fail a file that is perfectly fine.
for f in extension/*.js; do
  case "$(basename "$f" .js)" in
    background|config) ext=mjs ;;
    *)                 ext=js  ;;
  esac
  cp "$f" "/tmp/jd-check.$ext"
  if ! node --check "/tmp/jd-check.$ext"; then
    annotate "$f" "syntax error"
    fail=1
  fi
done

echo "==> Stylesheet syntax (esbuild parse)"
# A CSS syntax error does not throw — the browser's error recovery swallows the
# NEXT rule whole and carries on, so a stray brace silently deletes a rule and
# nothing anywhere reports it. Two of them shipped in popup.css for two days and
# were found only because a minifier happened to parse the file. Any warning
# fails: there is no such thing as a stylesheet warning worth keeping.
for f in extension/*.css site/*.css; do
  out=$(npx esbuild "$f" --outfile=/dev/null --log-level=warning 2>&1)
  if [ -n "$out" ]; then
    annotate "$f" "$(echo "$out" | head -1)"
    echo "$out"
    fail=1
  fi
done

echo "==> Site Content-Security-Policy (vercel.json)"
# The policy pins two things that are edited elsewhere: the Convex origin in
# site/config.js (swapped at every release) and the hash of each inline
# <script> in site/*.html. Either one drifting does not fail loudly in a
# browser. The admin console just stops reaching its backend, or an inline
# script stops running, and a page that looks fine has lost behaviour. So the
# policy is checked against both, here.
if ! python3 - <<'PY'
import base64, hashlib, json, re, sys, glob

csp = None
for rule in json.load(open("vercel.json")).get("headers", []):
    for h in rule.get("headers", []):
        if h["key"].lower() == "content-security-policy":
            csp = h["value"]
if csp is None:
    sys.exit("vercel.json sets no Content-Security-Policy")
directives = {d.split()[0]: d.split()[1:] for d in csp.split(";") if d.strip()}

bad = False
cfg = open("site/config.js").read()
url = re.search(r'JACKDAW_CONVEX_URL\s*=\s*"([^"]+)"', cfg).group(1)
if url.rstrip("/") not in directives.get("connect-src", []):
    print(f"connect-src does not allow {url} (site/config.js)")
    bad = True

for f in sorted(glob.glob("site/*.html")):
    html = open(f, encoding="utf-8").read()
    for m in re.finditer(r"<script(\s[^>]*)?>(.*?)</script>", html, re.S):
        attrs = m.group(1) or ""
        if "src=" in attrs or "application/ld+json" in attrs:
            continue
        digest = base64.b64encode(hashlib.sha256(m.group(2).encode()).digest()).decode()
        if f"'sha256-{digest}'" not in directives.get("script-src", []):
            print(f"{f}: inline script 'sha256-{digest}' is not in script-src")
            bad = True
sys.exit(1 if bad else 0)
PY
then
  annotate "vercel.json" "Content-Security-Policy out of step with the site"
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "==> ok"
fi
exit "$fail"
