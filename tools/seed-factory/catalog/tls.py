from .probes import from_probe

DEBIAN12 = {"name": "debian", "version": "12"}
HOST = "https://intranet.example:8443"

TASKS = (
    from_probe(
        "tls-git-private-ca", category="network", error_type="server certificate verification failed", runtime=DEBIAN12,
        summary="git fails to reach a server whose certificate was signed by a company root CA, with server certificate verification failed, because git does not trust that CA.",
        context="Cloning or fetching over HTTPS from an internal Git server inside a container or CI image without the company CA.",
        failed_approaches=(f"git config --global http.sslCAInfo /etc/ssl/certs/ca-certificates.crt && git ls-remote {HOST}/repo.git 2>&1", f"SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt git ls-remote {HOST}/repo.git 2>&1"),
        fix="git config --global http.sslCAInfo /opt/corp-ca/corp-root-ca.pem", verify=f"git ls-remote {HOST}/repo.git 2>&1 | grep -c 'verification failed' | grep -qx 0",
        root_cause="The internal server's certificate chains to a root that is not in the container's trust store. Pointing git at the system bundle changes nothing, because the company root is not in it either.",
        steps=("Give git the company root: git config --global http.sslCAInfo /path/to/root.pem (or set GIT_SSL_CAINFO).", "Better for a whole image: add the root to the system store (update-ca-certificates) so every tool trusts it.", "Do not set http.sslVerify=false: it removes the protection for every repository."),
        tags=("git", "tls", "private-ca", "docker"), message="server certificate verification failed",
    ),
    from_probe(
        "tls-python-requests-private-ca", category="network", error_type="SSLError", runtime=DEBIAN12,
        summary="Python requests raises SSLError, certificate verify failed: unable to get local issuer certificate, when the server's certificate was signed by a company root CA that the container does not trust.",
        context="Calling an internal HTTPS API from a script in a Debian container.",
        failed_approaches=(f"python3 -c \"import requests; requests.get('{HOST}/health', verify='/etc/ssl/certs/ca-certificates.crt')\" 2>&1", f"REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt python3 -c \"import requests; requests.get('{HOST}/health')\" 2>&1"),
        fix="cp /opt/corp-ca/corp-root-ca.pem /usr/local/share/ca-certificates/corp-root-ca.crt && update-ca-certificates >/dev/null", verify=f"python3 -c \"import requests; print(requests.get('{HOST}/health').text)\"",
        root_cause="requests verifies against a CA bundle. The Debian package uses the system store, so a company root has to be added there; pointing at the existing system bundle changes nothing.",
        steps=("Install the root: copy it to /usr/local/share/ca-certificates/ as a .crt file and run update-ca-certificates.", "Or pass verify='/path/to/root.pem' for one call, or set REQUESTS_CA_BUNDLE to a bundle that contains it.", "With pip-installed requests the bundle is certifi's: set REQUESTS_CA_BUNDLE or SSL_CERT_FILE, because update-ca-certificates does not reach it."),
        tags=("python", "requests", "tls", "private-ca"), message="requests.exceptions.SSLError",
    ),
    from_probe(
        "tls-pip-private-ca", category="network", error_type="CERTIFICATE_VERIFY_FAILED", runtime=DEBIAN12,
        summary="pip cannot reach a private package index whose certificate was signed by a company root CA and retries until it fails with CERTIFICATE_VERIFY_FAILED.",
        context="Installing from an internal Python index inside a container that does not trust the company root.",
        failed_approaches=("pip3 install --break-system-packages --cert /etc/ssl/certs/ca-certificates.crt --index-url https://intranet.example:8443/simple/ internal-package 2>&1", "PIP_CERT=/etc/ssl/certs/ca-certificates.crt pip3 install --break-system-packages --index-url https://intranet.example:8443/simple/ internal-package 2>&1"),
        fix="pip3 config set global.cert /opt/corp-ca/corp-root-ca.pem", verify="pip3 install --break-system-packages --index-url https://intranet.example:8443/simple/ internal-package 2>&1 | grep -qi 'no matching distribution\\|could not find a version\\|no versions'",
        root_cause="pip uses its own CA bundle, not the system store, unless told otherwise, and the company root is in neither. Pointing --cert at the system bundle does not help for the same reason.",
        steps=("Point pip at a bundle that contains the company root: pip config set global.cert /path/to/root.pem, or set PIP_CERT.", "Do not use --trusted-host as a fix: it turns verification off for that host.", "The index in this example returns no packages; the check only proves that the TLS handshake now succeeds."),
        tags=("python", "pip", "tls", "private-ca"), message="CERTIFICATE_VERIFY_FAILED",
    ),
    from_probe(
        "tls-openssl3-legacy-pkcs12", category="tooling", error_type="digital envelope routines unsupported", runtime=DEBIAN12,
        summary="OpenSSL 3 cannot read a PKCS#12 file protected with the old RC2 cipher and fails with digital envelope routines: unsupported, because that algorithm moved to the legacy provider.",
        context="Extracting a key or certificate from a .p12 or .pfx exported years ago, with openssl 3.x on a current Linux.",
        failed_approaches=("openssl pkcs12 -in /opt/lab/legacy.p12 -nodes -passin pass:changeit -provider default 2>&1", "OPENSSL_CONF=/dev/null openssl pkcs12 -in /opt/lab/legacy.p12 -nodes -passin pass:changeit 2>&1"),
        fix="openssl pkcs12 -legacy -in /opt/lab/legacy.p12 -nodes -passin pass:changeit -out /tmp/all.pem", verify="grep -q 'BEGIN CERTIFICATE' /tmp/all.pem",
        root_cause="OpenSSL 3 split its algorithms into providers and left obsolete ones, such as RC2 and the old PBE schemes of PKCS#12, in a legacy provider that is not loaded by default.",
        steps=("Add -legacy to the command (or -provider legacy -provider default).", "Convert the file once to a modern format so that nothing needs the flag again: read it with -legacy and export it with the default algorithms.", "Do not downgrade OpenSSL for this."),
        tags=("openssl", "pkcs12", "openssl3", "legacy-provider"), message="unsupported",
    ),
)

TASKS += (
    from_probe(
        "tls-curl-hostname-mismatch", category="network", error_type="no alternative certificate subject name matches", runtime=DEBIAN12,
        summary="curl rejects a certificate when the host in the URL is not one of the names the certificate lists, even though its CA is trusted; connecting by IP address or localhost is the usual cause.",
        context="Calling an internal HTTPS service by IP address, localhost or an alias while its certificate was issued for a DNS name.",
        failed_approaches=("curl -sS --cacert /opt/corp-ca/corp-root-ca.pem https://localhost:8443/health 2>&1", "curl -sS --cacert /etc/ssl/certs/ca-certificates.crt https://127.0.0.1:8443/health 2>&1"),
        fix="curl -sS --cacert /opt/corp-ca/corp-root-ca.pem https://intranet.example:8443/health", verify="curl -sS --cacert /opt/corp-ca/corp-root-ca.pem https://intranet.example:8443/health | grep -q 'ok intranet health'",
        root_cause="A client checks that the name in the URL matches a subject alternative name of the certificate, separately from checking the CA. The certificate lists intranet.example, so 127.0.0.1 and localhost do not match.",
        steps=("Use a name the certificate lists in the URL (add it to /etc/hosts or DNS if needed), or tell curl to resolve it: --resolve intranet.example:8443:127.0.0.1.", "Or reissue the certificate with the other names (or IP addresses) in subjectAltName.", "Do not use -k: it turns off the CA check as well."),
        tags=("curl", "tls", "san", "hostname"), message="no alternative certificate subject name matches",
    ),
)
