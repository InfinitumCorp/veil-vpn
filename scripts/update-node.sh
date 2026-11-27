#!/usr/bin/env bash
# Updates the VEIL node code on a running server and, optionally, makes it a domestic relay.
# Run from the repo root on your own computer:
#   scripts/update-node.sh <ssh-host> [relay-node-id]
# With a relay id (the node's id in deploy/api/nodes.json, for example ru1-1) it sets RELAY_TO in
# /etc/veil-node.env to every exit whose "relayVia" names that id (scripts/relay-to.mjs).
# SSH_OPTS adds ssh/scp options (for example SSH_OPTS="-b 192.168.1.48" to leave a local VPN out).
# The old code stays in /opt/veil.prev; if veil-node does not come back healthy it is put back.
set -euo pipefail
HOST=${1:?usage: scripts/update-node.sh <ssh-host> [relay-node-id]}
RELAY_ID=${2:-}
SSH_OPTS=${SSH_OPTS:-}
cd "$(dirname "$0")/.."

RELAY_LINE=
if [ -n "$RELAY_ID" ]; then
  RELAY_LINE=$(node scripts/relay-to.mjs "$RELAY_ID")
  case "$RELAY_LINE" in RELAY_TO=?*) ;; *) echo "no exits name $RELAY_ID as relayVia" >&2; exit 1 ;; esac
fi

TAR=$(mktemp)
trap 'rm -f "$TAR"' EXIT
tar -czf "$TAR" node shared
# shellcheck disable=SC2086
scp -q $SSH_OPTS "$TAR" "$HOST:/tmp/veil-node.tgz"
# shellcheck disable=SC2086
ssh $SSH_OPTS "$HOST" "sudo RELAY_LINE='$RELAY_LINE' bash -s" <<'REMOTE'
set -euo pipefail
APP=/opt/veil
rm -rf "$APP.prev" /tmp/veil-new
cp -a "$APP" "$APP.prev"
mkdir /tmp/veil-new && tar -xzf /tmp/veil-node.tgz -C /tmp/veil-new
rm -rf "$APP/node" "$APP/shared"
cp -r /tmp/veil-new/node /tmp/veil-new/shared "$APP/"
rm -rf /tmp/veil-new /tmp/veil-node.tgz
cp -a /etc/veil-node.env /etc/veil-node.env.prev
if [ -n "$RELAY_LINE" ]; then
  sed -i '/^RELAY_TO=/d' /etc/veil-node.env
  echo "$RELAY_LINE" >> /etc/veil-node.env
fi
systemctl restart veil-node
set -a; . /etc/veil-node.env; set +a
for i in $(seq 1 15); do
  h=$(curl -fsS -m 3 -H "authorization: Bearer $AGENT_SECRET" "http://127.0.0.1:${AGENT_PORT:-9101}/health" 2>/dev/null || true)
  [ -n "$h" ] && break
  sleep 1
done
if [ -z "$h" ]; then
  echo "veil-node not healthy, putting the old code back" >&2
  rm -rf "$APP"; mv "$APP.prev" "$APP"; cp -a /etc/veil-node.env.prev /etc/veil-node.env
  systemctl restart veil-node
  exit 1
fi
echo "healthy: $h"
REMOTE
