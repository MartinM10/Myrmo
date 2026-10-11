# A fictional company's internal service framework, shipped as bytecode like the platform team's wheels. Version 3
# moved the service settings into sections and only answers an old file with an error code; the supported way out is
# a config migration command that its usage text does not list.
FROM python:3.12.4-slim-bookworm
COPY acme/acmeframe/ /usr/local/lib/python3.12/site-packages/acmeframe/
RUN cd /usr/local/lib/python3.12/site-packages \
 && python -m compileall -q -b acmeframe && find acmeframe -name '*.py' -delete && rm -rf acmeframe/__pycache__ \
 && mkdir -p /opt/acme && sha256sum acmeframe/*.pyc > /opt/acme/.integrity
WORKDIR /work
COPY files/ /work/
CMD ["sleep", "infinity"]
