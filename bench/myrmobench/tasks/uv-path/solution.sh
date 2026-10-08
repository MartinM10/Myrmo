#!/bin/sh
# Reference fix. Never shown to an agent: used by `run.py dry-run` to prove the task can be solved.
cd /work && sed -i '2a export PATH="$HOME/.cargo/bin:$PATH"' build.sh
