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

if [ "$fail" -eq 0 ]; then
  echo "==> ok"
fi
exit "$fail"
