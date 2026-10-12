#!/bin/sh
# Reference fix. Never shown to an agent: used by `run.py dry-run` to prove the task can be solved.
cd /work && /opt/acme/platform/lockctl release migrate --holder-gone && acmectl db migrate
