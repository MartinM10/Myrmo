#!/bin/sh
cp /opt/corp-ca/corp-root-ca.pem /usr/local/share/ca-certificates/corp-root-ca.crt && update-ca-certificates
