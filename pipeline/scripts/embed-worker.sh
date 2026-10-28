#!/bin/sh
# Drain the encode queue once. Safe to run from a timer: the queue is a table and a job is claimed by
# status, so overlapping runs cost a wasted attempt at worst.
set -eu
cd "$(dirname "$0")/.."
exec node src/cli.ts embed --limit "${EMBED_LIMIT:-200}"
