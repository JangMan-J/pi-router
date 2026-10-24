#!/bin/sh
# Type-check against the pi checkout that runs this machine's pi (default ~/pi; override with PI_SRC).
# .pi-src is a gitignored symlink so tsconfig.json can name pi's type entry points without an absolute path.
set -e
cd "$(dirname "$0")/.."
PI_SRC="${PI_SRC:-$HOME/pi}"
ln -sfn "$PI_SRC" .pi-src
exec "$PI_SRC/node_modules/.bin/tsc" -p tsconfig.json
