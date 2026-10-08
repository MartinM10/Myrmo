#!/bin/sh
# The build of our app image, as a script. Each line stands for one RUN step of the Dockerfile and runs in
# its own non-login shell.
set -e
sh -c 'uv --version'
sh -c 'uv venv /tmp/app-venv'
sh -c 'uv pip install --python /tmp/app-venv/bin/python --no-index --find-links /opt/wheels six'
sh -c '/tmp/app-venv/bin/python -c "import six; print(\"six\", six.__version__)"'
echo "BUILD OK"
