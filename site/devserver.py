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

    python3 site/devserver.py [port]
"""

import functools
import http.server
import os
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # `no-store` rather than `no-cache`: no-cache still permits a stored copy
        # subject to revalidation, and it is revalidation the heuristic skips.
        self.send_header("Cache-Control", "no-store, max-age=0, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # One line per request is useful; the default also prints the date twice.
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8788
    root = os.path.dirname(os.path.abspath(__file__))
    handler = functools.partial(NoCacheHandler, directory=root)
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print(f"jackdaws.app dev server → http://localhost:{port}  (no-store)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
