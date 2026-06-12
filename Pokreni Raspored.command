#!/bin/zsh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/server" || exit 1

(sleep 2; open "http://127.0.0.1:8787") &
npm start
