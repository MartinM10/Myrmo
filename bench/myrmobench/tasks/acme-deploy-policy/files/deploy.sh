#!/bin/sh
# Acme deploy wrapper. Usage: ./deploy.sh <staging|production>
# Checks the release policies, then hands the release to the platform's release service.
set -e
env="${1:?usage: ./deploy.sh <staging|production>}"
version="$(cat VERSION)"
if ! acme-policy check REL-7 --version "$version" --changelog CHANGELOG.md; then
  echo "deploy: policy REL-7 violated (release record incomplete)" >&2
  exit 3
fi
acmectl release push --env "$env" --version "$version"
