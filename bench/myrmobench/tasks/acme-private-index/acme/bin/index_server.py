#!/usr/bin/env python3
"""Acme's private package index (stands in for the company's artifact repository): a PEP 503 simple index that answers
only to HTTP Basic auth whose password is the machine's token in /etc/acme/pip-token."""
import base64
import http.server
import pathlib

ROOT = pathlib.Path("/opt/acme/index")
TOKEN = pathlib.Path("/etc/acme/pip-token").read_text().strip()


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def authorized(self) -> bool:
        header = self.headers.get("Authorization", "")
        if not header.startswith("Basic "):
            return False
        try:
            _, _, password = base64.b64decode(header[6:]).decode().partition(":")
        except Exception:
            return False
        return password == TOKEN

    def send(self, code: int, body: bytes = b"", kind: str = "text/html") -> None:
        self.send_response(code)
        if code == 401:
            self.send_header("WWW-Authenticate", 'Basic realm="Acme packages"')
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if not self.authorized():
            return self.send(401, b"401 Unauthorized: Acme packages need a token")
        parts = [p for p in self.path.split("?")[0].split("/") if p]
        if parts == ["simple"]:
            links = "".join(f'<a href="/simple/{d.name}/">{d.name}</a><br>' for d in ROOT.iterdir())
        elif len(parts) == 2 and parts[0] == "simple" and (ROOT / parts[1]).is_dir():
            links = "".join(f'<a href="/files/{parts[1]}/{f.name}">{f.name}</a><br>' for f in (ROOT / parts[1]).iterdir())
        elif len(parts) == 3 and parts[0] == "files" and (ROOT / parts[1] / parts[2]).is_file():
            return self.send(200, (ROOT / parts[1] / parts[2]).read_bytes(), "application/octet-stream")
        else:
            return self.send(404, b"not found")
        self.send(200, f"<html><body>{links}</body></html>".encode())


http.server.ThreadingHTTPServer(("127.0.0.1", 8081), Handler).serve_forever()
