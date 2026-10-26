#!/usr/bin/env bash
# Link host-provided peer packages from the global pi install into node_modules
# so `tsc --noEmit` and editors can resolve them. Dev-only: pi maps these
# packages itself at extension runtime; nothing here ships or runs in production.
set -euo pipefail

PI_ROOT="$(npm root -g)"
PI_PKG="$PI_ROOT/@earendil-works/pi-coding-agent"

if [ ! -d "$PI_PKG" ]; then
	echo "Global pi install not found at $PI_PKG" >&2
	echo "Is pi installed globally for the active node/npm?" >&2
	exit 1
fi

mkdir -p node_modules/@earendil-works
ln -sfn "$PI_PKG" node_modules/@earendil-works/pi-coding-agent
ln -sfn "$PI_PKG/node_modules/@earendil-works/pi-ai" node_modules/@earendil-works/pi-ai
ln -sfn "$PI_PKG/node_modules/typebox" node_modules/typebox

echo "Linked peer packages from $PI_PKG"
