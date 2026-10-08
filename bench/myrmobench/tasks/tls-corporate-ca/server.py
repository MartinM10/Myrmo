import http.server
import ssl

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok intranet health\n")

    def log_message(self, *args):
        pass

server = http.server.HTTPServer(("127.0.0.1", 8443), Handler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain("/opt/intranet/server.crt", "/opt/intranet/server.key")
server.socket = context.wrap_socket(server.socket, server_side=True)
server.serve_forever()
