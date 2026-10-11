# A fictional company's private package index, which answers only with the machine's token, and the internal CLI that
# configures pip for it. Nothing a model can know: the package does not exist on PyPI, and the way to authenticate is
# the company's own tool.
FROM python:3.12.4-slim-bookworm
# pip never waits for a username: an agent's shell has no terminal, and a prompt that waits forever hangs the agent
# instead of showing it the error (as CI machines set it).
ENV PIP_NO_INPUT=1
COPY acme/ /opt/acme/
RUN cd /opt/acme/pkg && pip wheel --no-deps --no-cache-dir -q -w /opt/acme/index/acmeco-internal-logging . \
 && rm -rf /opt/acme/pkg \
 && install -m 0755 /opt/acme/bin/acmectl /usr/local/bin/acmectl \
 && mkdir -p /etc/acme \
 && python3 -c "import secrets; print(secrets.token_hex(16))" > /etc/acme/pip-token && chmod 600 /etc/acme/pip-token \
 && printf '[global]\nextra-index-url = http://127.0.0.1:8081/simple/\n' > /etc/pip.conf \
 && sha256sum /opt/acme/bin/index_server.py /usr/local/bin/acmectl /etc/acme/pip-token > /opt/acme/.integrity
COPY start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh
WORKDIR /work
COPY files/ /work/
CMD ["/usr/local/bin/start.sh"]
