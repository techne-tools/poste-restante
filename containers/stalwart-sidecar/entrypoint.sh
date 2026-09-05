#!/bin/sh
# Stalwart sidecar entrypoint — minimal-boot, then exec the server.
#
# On first boot (no config.json) it writes the minimal RocksDb config —
# the same shape the dev sidecar uses on the Mac — and then starts the
# server in NORMAL mode. Provisioning (domain, IMAP listener, accounts) is
# the operator's step: recovery-mode apply with `stalwart-cli` from the
# dev Mac against a temporarily-published recovery port (deploy.sh
# `sidecar:provision`, README). The server itself never exposes the
# management API except in recovery mode, which only the operator starts.
set -e

CFG=/opt/stalwart/etc/config.json
DATA=/opt/stalwart/data

if [ ! -f "$CFG" ]; then
  mkdir -p "$(dirname "$CFG")" "$DATA"
  printf '{"@type":"RocksDb","path":"%s"}\n' "$DATA" > "$CFG"
  echo "stalwart: wrote minimal config ($CFG) — apply a plan to provision"
fi

exec stalwart -c "$CFG"
