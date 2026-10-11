#!/bin/sh
# Reference fix. Never shown to an agent: used by `run.py dry-run` to prove the task can be solved.
cd /work && python -m acmeframe migrate-config service.toml && python -m acmeframe check service.toml
