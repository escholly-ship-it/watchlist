#!/usr/bin/env bash
# Erzeugt aus escholly-ship-it/cowork: content/projects/app-repos/watchlist.json über scripts/app-repo-harness.py.
# Nicht hier von Hand ändern — dort ändern und neu erzeugen.
# Letzte Zeile: [pruefen] ERGEBNIS …  Exit 0 grün, 1 rot, 2 nicht gemessen.
set -u
cd "$(dirname "$0")/.."
lauf() {
  echo "[pruefen] $1"
  bash -c "$1" || { echo "[pruefen] ERGEBNIS rot: $1"; exit 1; }
}
lauf 'node --check app.js'
lauf 'node --check sync-merge.js'
lauf 'node --check sw.js'
lauf 'node --check worker/src/index.js'
lauf 'python3 -c "import json; json.load(open('\''manifest.json'\''))"'
lauf 'node --test worker/test/*.test.mjs test/*.test.mjs'
echo '[pruefen] ERGEBNIS grün: 6 Befehl(e)'
