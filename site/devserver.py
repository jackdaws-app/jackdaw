#!/usr/bin/env python3
"""Static dev server for site/ that never lets the browser cache anything.

Why this exists rather than `python3 -m http.server`: the stdlib server sends
`Last-Modified` and no cache directives, which lets a browser apply *heuristic
freshness* and serve `styles.css` from memory for minutes after it changed. The
symptom is nasty because it is silent and partial — new HTML renders against an
old stylesheet, so the page looks broken in ways that have nothing to do with
what you just wrote, and a plain reload does not fix it.

That cost real debugging time three separate times before this file existed.

Not used in production, where the real site is served as static files by the
host; this is only for `.claude/launch.json` and local work.

    python3 site/devserver.py [port] [root]

`root` defaults to this file's own directory, i.e. the raw sources. Pass
`dist/site` to serve a build instead — the minified output is a different
program from the one you edit (comments gone, locals renamed, directives
resolved), so "it works from site/" is not evidence that it works from dist.

A build is also served with the response headers `vercel.json` gives the real
site, the Content-Security-Policy among them, so a script the policy would
block fails here first instead of on jackdaws.app. The raw sources are served
without them: config.js is often pointed at the dev deployment during work,
and the policy only allows the production one.
"""

import functools
import http.server
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def host_headers():
    """The headers vercel.json sends on every path. Only the catch-all rule is
    read, because it is the only kind the file uses."""
    with open(os.path.join(os.path.dirname(HERE), "vercel.json")) as fh:
        config = json.load(fh)
    out = []
    for rule in config.get("headers", []):
        if rule.get("source") == "/(.*)":
            out.extend((h["key"], h["value"]) for h in rule["headers"])
    return out


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    extra_headers = ()

    def end_headers(self):
        # `no-store` rather than `no-cache`: no-cache still permits a stored copy
        # subject to revalidation, and it is revalidation the heuristic skips.
        self.send_header("Cache-Control", "no-store, max-age=0, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        for key, value in self.extra_headers:
            self.send_header(key, value)
        super().end_headers()

    def log_message(self, fmt, *args):
        # One line per request is useful; the default also prints the date twice.
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8788
    root = os.path.abspath(sys.argv[2]) if len(sys.argv) > 2 else HERE
    if not os.path.isdir(root):
        sys.stderr.write(f"no such directory: {root}\n")
        return 1
    if root != HERE:
        NoCacheHandler.extra_headers = tuple(host_headers())
    handler = functools.partial(NoCacheHandler, directory=root)
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print(f"jackdaws.app dev server → http://localhost:{port}  (no-store)")
        print(f"  serving {root}")
        if NoCacheHandler.extra_headers:
            print(f"  with {len(NoCacheHandler.extra_headers)} headers from vercel.json")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
