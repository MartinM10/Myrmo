"""Network, TLS and proxy errors reproduced offline in pinned python:3.12-slim (Debian 13).

Each task starts a local HTTP or HTTPS server in its setup (a background process, waited for before the failing command
runs). curl is installed in the setup, so it needs the package mirror when the factory runs. Nothing is reached outside
the container: every host name is localhost or a name the setup maps to 127.0.0.1, and the dead ends really exit non-zero.
tls.py already covers git, requests, pip, PKCS#12 and the curl subject-name mismatch; these tasks use other messages.
"""

from .base import Task

IMAGE = "python:3.12-slim"
RUNTIME = {"name": "debian", "version": "13"}

APT = "DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl >/dev/null"

# The server answers "ok lab health" on a plain port, or over TLS when given a certificate and key. It closes the TLS
# session cleanly, so a successful curl exits 0 and not 18 or 56.
SERVER_PY = r"""import http.server, ssl, sys
port = int(sys.argv[1])
BODY = b"ok lab health\n"
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Length", str(len(BODY)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(BODY)
    def finish(self):
        try:
            self.request.unwrap()
        except Exception:
            pass
        super().finish()
    def log_message(self, *args):
        pass
srv = http.server.HTTPServer(("127.0.0.1", port), H)
if len(sys.argv) > 3:
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(sys.argv[2], sys.argv[3])
    srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
srv.serve_forever()
"""


def _server(port: int, *tls: str) -> str:
    """Write the server script, start it in the background and wait until the port accepts connections."""
    args = " ".join((str(port), *tls))
    return "\n".join((
        "mkdir -p /opt/lab",
        f"cat > /opt/lab/srv.py <<'PY'\n{SERVER_PY}PY",
        f"python3 /opt/lab/srv.py {args} >/dev/null 2>&1 &",
        f"for i in 1 2 3 4 5 6 7 8 9 10; do python3 -c \"import socket; socket.create_connection(('127.0.0.1', {port}), 1)\" 2>/dev/null && break; sleep 0.5; done",
    ))


# A private root CA signs the server certificate for localhost. Keys are made in the container, never shipped.
CA_CHAIN = "\n".join((
    "mkdir -p /opt/lab/ca",
    "openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj '/CN=Lab Root CA' -keyout /opt/lab/ca/ca.key -out /opt/lab/ca/ca.pem 2>/dev/null",
    "printf 'subjectAltName=DNS:localhost\\n' > /opt/lab/ca/san.cnf",
    "openssl req -newkey rsa:2048 -nodes -subj '/CN=localhost' -keyout /opt/lab/ca/server.key -out /opt/lab/ca/server.csr 2>/dev/null",
    "openssl x509 -req -in /opt/lab/ca/server.csr -CA /opt/lab/ca/ca.pem -CAkey /opt/lab/ca/ca.key -CAcreateserial -days 3650 -extfile /opt/lab/ca/san.cnf -out /opt/lab/ca/server.crt 2>/dev/null",
))

# A single self-signed certificate that is its own trust anchor (no CA).
SELF_SIGNED = (
    "mkdir -p /opt/lab/ca && openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj '/CN=localhost' "
    "-addext 'subjectAltName=DNS:localhost' -keyout /opt/lab/ca/self.key -out /opt/lab/ca/self.crt 2>/dev/null"
)

TASKS = (
    Task(
        task_id="net-curl-private-ca-unknown-issuer",
        image=IMAGE,
        runtime=RUNTIME,
        category="network",
        error_type="SSL certificate problem",
        summary="curl refuses an HTTPS server whose certificate was signed by a private root CA the container does not trust, and fails with SSL certificate problem: unable to get local issuer certificate.",
        context="Calling an internal HTTPS service from a Debian container whose trust store has only the public roots.",
        setup="\n".join((APT, CA_CHAIN, _server(8443, "/opt/lab/ca/server.crt", "/opt/lab/ca/server.key"))),
        failing_command='curl -sS https://localhost:8443/health 2>&1',
        failed_approaches=(
            "curl -sS --cacert /etc/ssl/certs/ca-certificates.crt https://localhost:8443/health 2>&1",
            "curl -sS --capath /etc/ssl/certs https://localhost:8443/health 2>&1",
        ),
        fix_command="cp /opt/lab/ca/ca.pem /usr/local/share/ca-certificates/lab-root-ca.crt && update-ca-certificates >/dev/null 2>&1",
        verification_command="curl -sS https://localhost:8443/health",
        root_cause="The server certificate chains to a root that is not in the container's trust store. curl on Debian verifies against /etc/ssl/certs/ca-certificates.crt, which holds only public roots, so it cannot build a chain and reports unable to get local issuer certificate. Pointing curl at the same bundle or at a hashed directory changes nothing.",
        steps=(
            "Add the private root certificate to the system store as a .crt file and run update-ca-certificates. curl on Debian then trusts it without flags.",
            "For a single tool or a single command, point curl at the root with --cacert or CURL_CA_BUNDLE, or with cacert = <file> in ~/.curlrc.",
            "Do not use -k or --insecure: it removes the check for every host.",
        ),
        tags=("curl", "tls", "private-ca", "ca-certificates"),
        ecosystem="network", written_by_model="claude-haiku-5-5",
    ),
    Task(
        task_id="net-curl-self-signed-leaf",
        image=IMAGE,
        runtime=RUNTIME,
        category="network",
        error_type="SSL certificate problem",
        summary="curl rejects an HTTPS server that presents a self-signed certificate with no CA above it, and fails with SSL certificate problem: self-signed certificate.",
        context="Calling a development or appliance HTTPS endpoint that generated its own certificate, from a Debian container.",
        setup="\n".join((APT, SELF_SIGNED, _server(8444, "/opt/lab/ca/self.crt", "/opt/lab/ca/self.key"))),
        failing_command='curl -sS https://localhost:8444/health 2>&1',
        failed_approaches=(
            "curl -sS --cacert /etc/ssl/certs/ca-certificates.crt https://localhost:8444/health 2>&1",
            "curl -sS --capath /etc/ssl/certs https://localhost:8444/health 2>&1",
        ),
        fix_command="cp /opt/lab/ca/self.crt /usr/local/share/ca-certificates/lab-self.crt && update-ca-certificates >/dev/null 2>&1",
        verification_command="curl -sS https://localhost:8444/health",
        root_cause="The certificate is its own issuer and is not in any trust store, so OpenSSL has no trusted anchor to end the chain on and curl reports self-signed certificate. Public roots in the bundle cannot help, because no CA signed this certificate.",
        steps=(
            "Trust the exact certificate: copy it to /usr/local/share/ca-certificates/ as a .crt file and run update-ca-certificates.",
            "Or pass that certificate to curl with --cacert for one command. Check that the certificate is the one the server presents (openssl s_client) before you trust it.",
            "Regenerating the certificate with a real CA, or with the right subjectAltName, is the better long-term fix; trusting a self-signed certificate system-wide is a stopgap.",
        ),
        tags=("curl", "tls", "self-signed", "ca-certificates"),
        ecosystem="network", written_by_model="claude-haiku-5-5",
    ),
    Task(
        task_id="net-curl-proxy-dead-port",
        image=IMAGE,
        runtime=RUNTIME,
        category="network",
        error_type="Failed to connect",
        summary="curl fails to reach a plain HTTP server on localhost because an inherited http_proxy variable points at a proxy port where nothing listens, with Failed to connect to 127.0.0.1 port 3128.",
        context="Running a health check against a service on the same machine from a shell that inherited a corporate proxy setting, where the proxy is not running.",
        setup="\n".join((APT, _server(8080), "export http_proxy=http://127.0.0.1:3128")),
        failing_command="curl -sS http://localhost:8080/health 2>&1",
        failed_approaches=(
            "curl -sS --noproxy '' http://localhost:8080/health 2>&1",
            "curl -sS -x http://127.0.0.1:3128 http://localhost:8080/health 2>&1",
        ),
        fix_command="export no_proxy=localhost,127.0.0.1",
        verification_command="curl -sS http://localhost:8080/health",
        root_cause="curl sends every request through http_proxy unless the host matches no_proxy. localhost is not excluded by default, so the request goes to the proxy at 127.0.0.1:3128, which is not running, and curl fails before it reaches the server. Passing --noproxy '' or -x with the same dead proxy keeps the proxy in the path.",
        steps=(
            "Add localhost and 127.0.0.1 to no_proxy (or NO_PROXY) so that local addresses bypass the proxy.",
            "Find where the proxy variable is set (/etc/environment, a profile script, the CI settings) and remove it for the local service, or unset it for that one command.",
            "If the proxy should be running, start it; a dead proxy port is the usual cause of this message.",
        ),
        tags=("curl", "proxy", "no-proxy", "environment"),
        ecosystem="network", written_by_model="claude-haiku-5-5",
    ),
    Task(
        task_id="net-curl-closed-port-endpoint-config",
        image=IMAGE,
        runtime=RUNTIME,
        category="network",
        error_type="Could not connect to server",
        summary="A health check fails with Failed to connect to localhost port 8081 after 0 ms: Could not connect to server, because its endpoint file names a port that no service listens on.",
        context="A script reads its target URL from a config file that was copied from another environment, while the local service runs on a different port.",
        setup="\n".join((APT, _server(8080), "printf 'http://localhost:8081/health\\n' > /opt/lab/endpoint.txt")),
        failing_command='curl -sS "$(cat /opt/lab/endpoint.txt)" 2>&1',
        failed_approaches=(
            "curl -sS http://127.0.0.1:8081/health 2>&1",
            "curl -sS -m 3 http://localhost:8081/health 2>&1",
        ),
        fix_command="printf 'http://localhost:8080/health\\n' > /opt/lab/endpoint.txt",
        verification_command='curl -sS "$(cat /opt/lab/endpoint.txt)"',
        root_cause="The URL in the config names port 8081, where nothing is listening, while the service runs on 8080. curl reports a refused connection because the kernel answers the SYN with a reset, which is what a closed port does. Retrying the same closed port from another address does not change the result.",
        steps=(
            "Compare the port in the config with the port the service really listens on (ss -ltn, or the service's own log).",
            "Correct the endpoint in the config so it matches the service, or start the service on the port the config names.",
            "A refused connection means the port has no listener; a timeout would mean a firewall or an unreachable host instead.",
        ),
        tags=("curl", "connection-refused", "config", "port"),
        ecosystem="network", written_by_model="claude-haiku-5-5",
    ),
    Task(
        task_id="net-curl-could-not-resolve-host",
        image=IMAGE,
        runtime=RUNTIME,
        category="network",
        error_type="Could not resolve host",
        summary="curl cannot reach a service by its name because the name is not in DNS or /etc/hosts in an offline container, and fails with Could not resolve host: intranet.test.",
        context="Calling an internal service by a short name inside a container that has no DNS record for it and no network access to a resolver.",
        setup="\n".join((APT, _server(8080))),
        failing_command="curl -sS http://intranet.test:8080/health 2>&1",
        failed_approaches=(
            "getent hosts intranet.test",
            "curl -sS http://intranet.test.:8080/health 2>&1",
        ),
        fix_command="echo '127.0.0.1 intranet.test' >> /etc/hosts",
        verification_command="curl -sS http://intranet.test:8080/health",
        root_cause="The resolver has no record for intranet.test: neither the container's DNS server nor /etc/hosts contains it, and in an offline container no DNS server can answer. getent and the trailing-dot form query the same resolver and fail the same way.",
        steps=(
            "Give the name an address: add it to /etc/hosts (127.0.0.1 for a service in the same container), or add a record on the DNS server.",
            "If the name should resolve on a network, check the container's resolv.conf and the --dns or search settings of the runtime.",
            "Compare the spelling of the name with the one the service's certificate and configuration use.",
        ),
        tags=("curl", "dns", "etc-hosts", "resolver"),
        ecosystem="network", written_by_model="claude-haiku-5-5",
    ),
    Task(
        task_id="net-curl-https-to-http-port",
        image=IMAGE,
        runtime=RUNTIME,
        category="network",
        error_type="wrong version number",
        summary="curl fails with TLS connect error: wrong version number when https:// is used against a plain HTTP port, because the server does not speak TLS.",
        context="Calling a local service that serves plain HTTP on a port, from a config file that wrote the URL with https.",
        setup="\n".join((APT, _server(8080), "printf 'https://localhost:8080/health\\n' > /opt/lab/endpoint.txt")),
        failing_command='curl -sS "$(cat /opt/lab/endpoint.txt)" 2>&1',
        failed_approaches=(
            'curl -sS -k "$(cat /opt/lab/endpoint.txt)" 2>&1',
            "curl -sS --http1.1 https://localhost:8080/health 2>&1",
        ),
        fix_command="sed -i 's#^https://#http://#' /opt/lab/endpoint.txt",
        verification_command='curl -sS "$(cat /opt/lab/endpoint.txt)"',
        root_cause="The client starts a TLS handshake, and the server answers with plain HTTP, so OpenSSL reads an HTTP status line as a TLS record and reports wrong version number. The problem is the scheme in the URL, not the certificate or the TLS settings, so -k and HTTP/1.1 change nothing.",
        steps=(
            "Use the scheme the service speaks: http:// for a plain port, https:// only when the server has a TLS listener.",
            "Check which listener is on the port (curl -v http://... or the service's configuration) before changing the scheme.",
            "Do not add -k: it cannot turn a plain-HTTP answer into TLS, and it hides real certificate errors when TLS is in use.",
        ),
        tags=("curl", "tls", "scheme", "plain-http"),
        ecosystem="network", written_by_model="claude-haiku-5-5",
    ),
)
