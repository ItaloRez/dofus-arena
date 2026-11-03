#!/bin/sh
set -e
cd "$(dirname "$0")"
CLIENT=/Volumes/ssd/www/jogos/dofus-pvp/pvp/client/ node tools/swf/export.cjs sprite 1219
DUMMY_GFX=1219 docker compose up -d --build
