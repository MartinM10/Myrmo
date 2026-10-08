from probe import P

LAB = "myrmo-tls-lab:1"
START = "/opt/lab/start.sh"
OPENSSL_DOC = "https://raw.githubusercontent.com/openssl/openssl/openssl-3.0/crypto/x509/x509_txt.c"

PROBES = [
    P("tls-curl-private-ca", "tls", LAB, START, "curl -sS https://intranet.example:8443/health 2>&1", r"SSL certificate problem",
      {"curl": "7.88", "os": "debian-12"}, OPENSSL_DOC, "unable to get local issuer certificate", "Apache-2.0",
      must=(r"CA|certificate", r"update-ca-certificates|--cacert|CURL_CA_BUNDLE|ca-certificates"), local_image=True),
    P("tls-git-private-ca", "tls", LAB, START, "git ls-remote https://intranet.example:8443/repo.git 2>&1", r"SSL certificate problem|server certificate verification failed",
      {"git": "2.39", "os": "debian-12"}, OPENSSL_DOC, "unable to get local issuer certificate", "Apache-2.0",
      must=(r"git", r"sslCAInfo|GIT_SSL_CAINFO|update-ca-certificates|http\.sslVerify"), local_image=True),
    P("tls-python-requests-private-ca", "tls", LAB, START,
      "python3 -c \"import requests; requests.get('https://intranet.example:8443/health')\" 2>&1", r"requests\.exceptions\.SSLError",
      {"requests": "2.28", "python": "3.11"}, OPENSSL_DOC, "unable to get local issuer certificate", "Apache-2.0",
      must=(r"requests|python", r"REQUESTS_CA_BUNDLE|SSL_CERT_FILE|certifi|verify="), local_image=True),
    P("tls-node-fetch-private-ca", "tls", LAB, START,
      "node -e \"fetch('https://intranet.example:8443/health').catch((e) => { console.error(e); process.exit(1) })\" 2>&1", r"unable to verify the first certificate|UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      {"node": "18", "os": "debian-12"}, OPENSSL_DOC, "unable to get local issuer certificate", "Apache-2.0",
      must=(r"node|fetch", r"NODE_EXTRA_CA_CERTS"), local_image=True),
    P("tls-java-pkix-private-ca", "tls", LAB, START,
      "printf 'public class G { public static void main(String[] a) throws Exception { new java.net.URL(\"https://intranet.example:8443/health\").openStream().close(); } }\\n' > /tmp/G.java && java /tmp/G.java 2>&1",
      r"PKIX path building failed",
      {"java": "17", "os": "debian-12"}, OPENSSL_DOC, "unable to get local issuer certificate", "Apache-2.0",
      must=(r"PKIX|java", r"keytool|cacerts|trustStore"), local_image=True),
    P("tls-openssl3-ee-key-too-small", "tls", LAB, START, "curl -sS --cacert /opt/corp-ca/corp-root-ca.pem https://intranet.example:8444/health 2>&1", r"EE certificate key too weak|ee key too small",
      {"openssl": "3.0", "os": "debian-12"}, "https://raw.githubusercontent.com/openssl/openssl/openssl-3.0/doc/man3/SSL_CTX_set_security_level.pod",
      "security level", "Apache-2.0", must=(r"ee key too small|security level|SECLEVEL", r"OpenSSL|openssl")),
    P("tls-openssl3-legacy-pkcs12", "tls", LAB, "true", "openssl pkcs12 -in /opt/lab/legacy.p12 -nodes -passin pass:changeit 2>&1", r"unsupported",
      {"openssl": "3.0", "os": "debian-12"}, "https://raw.githubusercontent.com/openssl/openssl/openssl-3.0/doc/man7/migration_guide.pod",
      "legacy provider", "Apache-2.0", must=(r"-legacy|legacy provider|-provider", r"pkcs12|PKCS")),
    P("tls-pip-private-ca", "tls", LAB, START, "pip3 install --break-system-packages --index-url https://intranet.example:8443/simple/ internal-package 2>&1", r"CERTIFICATE_VERIFY_FAILED",
      {"pip": "23", "os": "debian-12"}, "https://raw.githubusercontent.com/pypa/pip/24.0/NEWS.rst",
      "cert", "MIT", must=(r"pip", r"pip config set global\.cert|--cert|PIP_CERT|REQUESTS_CA_BUNDLE|SSL_CERT_FILE"), local_image=True),
    P("tls-curl-hostname-mismatch", "tls", LAB, START, "curl -sS --cacert /opt/corp-ca/corp-root-ca.pem https://127.0.0.1:8443/health 2>&1", r"no alternative certificate subject name matches",
      {"curl": "7.88", "os": "debian-12"}, "https://raw.githubusercontent.com/openssl/openssl/openssl-3.0/crypto/x509/x509_txt.c",
      "hostname mismatch", "Apache-2.0", must=(r"subject name|hostname|SAN|subjectAltName", r"--resolve|hostname|/etc/hosts|SAN"), local_image=True),
]
