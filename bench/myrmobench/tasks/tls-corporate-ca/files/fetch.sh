#!/bin/sh
# Reads the health of the company's internal service.
set -e
curl -sS --fail https://intranet.example:8443/health
