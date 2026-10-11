#!/bin/sh
# Reference fix. Never shown to an agent: used by `run.py dry-run` to prove the task can be solved.
cd /work && acmectl db unlock --stale && acmectl db migrate
