<!-- Erzeugt aus escholly-ship-it/cowork: content/projects/app-repos/watchlist.json über scripts/app-repo-harness.py. Nicht hier von Hand ändern — dort ändern und neu erzeugen. -->

# watchlist — wie hier gearbeitet wird

Dieses Repo gehört zum Projekt „watchlist“: Watchlist (statische App mit Worker). Es gilt der Vertrag in `escholly-ship-it/cowork`, dort `AGENTS.md`, vollständig, auch wo dieser Text ihn nicht wiederholt. Ein Thread arbeitet mit cowork als erstem Repo (Vertrag, Skills, Prüfer) und hängt dieses per `add_repo` an. Backlog: `wiki/projects/watchlist-backlog.md` in cowork; Beschlüsse dort sind bindend.

## Prüfen

`bash scripts/pruefen.sh` am PR-Stand. Die letzte Zeile beginnt mit `[pruefen] ERGEBNIS`; Exit 0 heißt grün, 1 rot, 2 nicht gemessen. „Nicht gemessen“ ist für einen Code-Diff nie grün.

Er fährt der Reihe nach: `node --check app.js`, `node --check sync-merge.js`, `node --check sw.js`, `node --check worker/src/index.js`, `python3 -c "import json; json.load(open('manifest.json'))"`, `node --test worker/test/*.test.mjs test/*.test.mjs`.

Was er belegt: Syntax von App, Service Worker, Sync-Zusammenführung und Worker, ein lesbares manifest.json und alle Node-Tests unter worker/test/ und test/. Das ist .github/workflows/checks.yml (nachgesehen 30.10.2026) plus worker/test/magazine.test.mjs, das checks.yml nicht nennt. Das package.json an der Wurzel trägt nur express für den lokalen Dev-Server (node server.js); einen Test-Befehl hat es nicht.

## Merge und Readback

main trägt keinen Branch-Schutz (nachgesehen 30.10.2026, protected false); ein roter oder laufender Check hält den Merge über die GitHub-Werkzeuge nicht. Gemergt wird nur bei Exit 0 von scripts/pruefen.sh am zu mergenden Stand — Disziplin, keine Mechanik.

GitHub Pages liefert main aus: https://escholly-ship-it.github.io/watchlist/ antwortet 200, und app.js dort ist byte-gleich mit app.js am Merge-Commit (so gemessen 30.10.2026 an af26324). Der Worker wird nicht mit dem Merge ausgerollt: wrangler deploy und jede Änderung an seinen Secrets nur nach „Freigabe“ (ops/register.md, Zeile „Projects watchlist“).

## Messwerte und Fallstricke

- Gemessen 30.10.2026 an af26324 (Node 22) im Cloud-Container: alle sechs Befehle grün, 50 von 50 Node-Tests.
