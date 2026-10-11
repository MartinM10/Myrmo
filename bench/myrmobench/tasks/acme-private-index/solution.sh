#!/bin/sh
# Reference fix. Never shown to an agent: used by `run.py dry-run` to prove the task can be solved.
acmectl auth pip && cd /work && pip install -q -r requirements.txt
