#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Build jackdaws.app into dist/site/
#
# The site shipped its sources verbatim for its whole life, which cost more
# than it sounds: styles.css is the only render-blocking asset on the page, and
# roughly four fifths of it is comments and whitespace. Minifying it is the one
# substantial performance win available on this site — everything else is
# already at the bottom of the body or already minified upstream.
#
# WHY THIS FILE IS TRACKED. It runs on the host, which deploys from the git
# repository and cannot see anything untracked.
#
# WHAT IS DELIBERATELY NOT MINIFIED, and why each one:
#
#   vendor/*        Already minified upstream, and each carries the licence
#                   notice that makes shipping it legal. Re-minifying risks
#                   the notice and buys nothing. Copied byte-for-byte, which
#                   is also what keeps them byte-comparable with the versions
#                   recorded in vendor/NOTICE.md.
#   *.html          esbuild has no HTML minifier, and the documents are the
#                   legal floor: privacy.html and terms.html must stay
#                   byte-comparable with PRIVACY.md and TERMS.md once tags are
#                   stripped, which a transform is one bug away from breaking.
#   fonts, images   Already compressed formats.
#
# NEVER ADD --mangle-props. Four cross-file contracts are plain property
# access and would break silently: window.JD (motion.js -> main.js),
# window.JackdawBrand, window.JackdawAdmin (admin-shell.js -> admin.js and
# admin-policies.js), window.JackdawPolicy, plus policy.js's returned
# {render, renderToc, escapeHtml, hydrate}, which node requires by name from
# policy-sync.js. Whitespace, comments and local identifiers only — which is
# also the line the Chrome Web Store's Code Readability policy draws, and the
# extension build states the same rule for the same reason.
#
# NO SOURCEMAPS. They would publish ~350KB of map alongside the thing we just
# spent the build shrinking, and the Corresponding Source an AGPL reader is
# owed is the repository the banner names, not a .map file.
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="site"
OUT="dist/site"
ESBUILD="node_modules/.bin/esbuild"

# The source already uses optional chaining and nullish coalescing, so ES2020
# is the floor the code assumed before this script existed. Naming it here
# pins that rather than letting esbuild's default pick a moving one; it only
# constrains the OUTPUT syntax, and nothing is downlevelled.
TARGET="es2020"

# THE BUILT FILE MUST BE THE SAME PROGRAM AS THE SOURCE, and one flag decides
# it. esbuild walks up from each input looking for a tsconfig.json and honours
# `alwaysStrict` out of whatever it finds — and the root tsconfig here sets
# `strict: true`, which implies it. Its `include` names only convex/**, its
# `exclude` names extension/, and `allowJs` is false, but none of those are
# esbuild's concept: it took the compiler option and prepended "use strict" to
# every file in this directory. These are CLASSIC SCRIPTS served sloppy from
# site/ in development, so that silently gave the built site different
# semantics from the one being developed against — and an implicit global
# would have thrown in production and nowhere else. An empty override reads
# no tsconfig at all.
TSCONFIG='--tsconfig-raw={}'

BANNER="/*! Jackdaw — https://github.com/jackdaws-app/jackdaw
 Minified for distribution. Original source and licence at the URL above;
 third-party notices ship in vendor/NOTICE.md. */"

# Maintainer tools and local notes that live in site/ because that is where
# they are used, and must not be served. DEPLOY.md is gitignored so the host
# never sees it, but the publish directory containing it at all is one
# deploy-from-laptop away from publishing it.
EXCLUDE="DEPLOY.md devserver.py policy-sync.js"

[ -x "$ESBUILD" ] || { echo "esbuild not found at $ESBUILD — run npm install" >&2; exit 1; }

excluded() { case " $EXCLUDE " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

rm -rf "$OUT"
mkdir -p "$OUT"

# Everything that is not our own JS or CSS is copied byte-for-byte: HTML, the
# fonts, og.png, favicon.svg, robots.txt, sitemap.xml, and all of vendor/.
( cd "$SRC" && find . -type f ! -name "*.js" ! -name "*.css" -print0 ) \
  | while IFS= read -r -d '' f; do
      b="${f#./}"
      excluded "$b" && continue
      mkdir -p "$OUT/$(dirname "$b")"
      cp "$SRC/$b" "$OUT/$b"
    done
# Vendor JS is already minified and carries its own notices — copy, do not build.
( cd "$SRC" && find . -type f \( -name "*.js" -o -name "*.css" \) -path "./vendor/*" -print0 ) \
  | while IFS= read -r -d '' f; do
      b="${f#./}"
      mkdir -p "$OUT/$(dirname "$b")"
      cp "$SRC/$b" "$OUT/$b"
    done

for f in "$SRC"/*.js; do
  b=$(basename "$f")
  excluded "$b" && continue
  "$ESBUILD" "$f" --minify --target="$TARGET" "$TSCONFIG" --legal-comments=eof \
    --banner:js="$BANNER" --outfile="$OUT/$b" --log-level=warning
done

for f in "$SRC"/*.css; do
  b=$(basename "$f")
  "$ESBUILD" "$f" --minify --target="$TARGET" "$TSCONFIG" --legal-comments=eof \
    --banner:css="$BANNER" --outfile="$OUT/$b" --log-level=warning
done

# Report what it bought, per file and in total. A build that silently produced
# a byte-identical copy would otherwise look exactly like a successful one.
python3 - "$SRC" "$OUT" <<'PY'
import sys, os, gzip
src, out = sys.argv[1], sys.argv[2]
def gz(p):
    with open(p, "rb") as fh: return len(gzip.compress(fh.read(), 9))
rows, ts, to = [], 0, 0
for name in sorted(os.listdir(out)):
    p_out = os.path.join(out, name)
    p_src = os.path.join(src, name)
    if not os.path.isfile(p_out) or not name.endswith((".js", ".css")): continue
    a, b = gz(p_src), gz(p_out)
    ts += a; to += b
    if a != b: rows.append((name, a, b))
w = max((len(r[0]) for r in rows), default=4)
print(f"\n  {'file'.ljust(w)}   {'gzipped':>9} {'built':>9}   saved")
for name, a, b in rows:
    print(f"  {name.ljust(w)}   {a:>9,} {b:>9,}   {100*(a-b)/a:5.1f}%")
print(f"  {'-'*w}   {'-'*9} {'-'*9}   -----")
print(f"  {'total'.ljust(w)}   {ts:>9,} {to:>9,}   {100*(ts-to)/ts:5.1f}%\n")
PY

echo "==> dist/site ready"
