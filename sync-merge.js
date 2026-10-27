/* ============================================
   WATCHLIST — Sync-Zusammenfuehrung (WL-33)
   ============================================
   Reine Funktionen ohne DOM, im Browser vor app.js geladen; der Test
   (test/sync-merge.test.mjs) fuehrt die Datei in einem eigenen Kontext aus.

   Regel je Titel-id: nur auf einer Seite -> bleibt; auf beiden -> die
   Fassung mit dem groesseren updatedAt (sonst addedAt, sonst 0), bei
   Gleichstand die Server-Fassung mit der juengeren Anbieter-Pruefung. Geloeschte Titel reisen als Marker
   { ...titel, deleted: true, updatedAt } mit und gewinnen wie jede andere
   Aenderung; Marker aelter als 30 Tage fallen weg. Ein leerer Server-Stand
   loescht damit lokal nichts.
*/
(function (root) {
  const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const SHORTLIST_MAX = 5;

  function stamp(it) {
    return Number(it && (it.updatedAt || it.addedAt)) || 0;
  }

  function isValid(it) {
    return it && typeof it === 'object' && it.id != null;
  }

  // Zwei Geraete koennen denselben TMDB-Titel unabhaengig anlegen (je eigene id).
  // Es bleibt die neuere Fassung, bei Gleichstand die kleinere id — auf jedem
  // Geraet dieselbe Wahl.
  function dedupeByTitle(list) {
    const best = new Map();
    for (const it of list) {
      if (it.deleted || it.tmdbId == null) continue;
      const k = `${it.type}:${it.tmdbId}`;
      const cur = best.get(k);
      if (!cur || stamp(it) > stamp(cur) || (stamp(it) === stamp(cur) && String(it.id) < String(cur.id))) {
        best.set(k, it);
      }
    }
    return list.filter(it => it.deleted || it.tmdbId == null || best.get(`${it.type}:${it.tmdbId}`) === it);
  }

  // Zwei Geraete koennen dieselbe Shortlist-Position vergeben haben: neu
  // nummerieren, gesehene raus, hoechstens SHORTLIST_MAX. updatedAt bleibt.
  function normalizeShortlist(list) {
    const sl = list
      .filter(it => !it.deleted && it.shortlist != null)
      .sort((a, b) => (a.shortlist - b.shortlist) || (stamp(b) - stamp(a)));
    let pos = 0;
    for (const it of sl) {
      if (it.watched || pos >= SHORTLIST_MAX) { it.shortlist = null; continue; }
      it.shortlist = pos++;
    }
    for (const it of list) if (it.deleted && it.shortlist != null) it.shortlist = null;
  }

  // Gleichstand: Server-Fassung, aber die juengere Anbieter-Pruefung bleibt.
  // Eine Neupruefung ohne neuen Anbieter setzt nur providers.checkedAt (kein
  // updatedAt); ginge sie verloren, liefe sie bei jedem Start erneut.
  function keepNewerCheck(remote, local) {
    const lc = Number(local.providers && local.providers.checkedAt) || 0;
    const rc = Number(remote.providers && remote.providers.checkedAt) || 0;
    if (lc <= rc) return remote;
    return { ...remote, providers: { ...(remote.providers || {}), checkedAt: lc } };
  }

  // local, remote: Listen mit Titeln und Markern. Liefert eine neue Liste
  // (Objekte werden kopiert, Eingaben bleiben unveraendert).
  function mergeItems(local, remote, now) {
    const byId = new Map();
    for (const it of remote || []) if (isValid(it)) byId.set(String(it.id), it);
    for (const it of local || []) {
      if (!isValid(it)) continue;
      const r = byId.get(String(it.id));
      if (!r || stamp(it) > stamp(r)) byId.set(String(it.id), it);
      else if (stamp(it) === stamp(r)) byId.set(String(it.id), keepNewerCheck(r, it));
    }
    const t = now == null ? Date.now() : now;
    let out = [];
    for (const it of byId.values()) {
      if (it.deleted && t - stamp(it) > TOMBSTONE_TTL_MS) continue;
      out.push({ ...it });
    }
    out = dedupeByTitle(out);
    normalizeShortlist(out);
    // Neueste zuerst, wie items.unshift beim Hinzufuegen.
    out.sort((a, b) => (Number(b.addedAt) || 0) - (Number(a.addedAt) || 0));
    return out;
  }

  function splitItems(list) {
    const live = [];
    const deleted = [];
    for (const it of list || []) (it && it.deleted ? deleted : live).push(it);
    return { live, deleted };
  }

  function makeTombstone(item, now) {
    return { ...item, deleted: true, shortlist: null, updatedAt: now == null ? Date.now() : now };
  }

  // Schluessel-Reihenfolge darf keinen Unterschied machen (alte Clients).
  function stableStringify(v) {
    if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
    if (v && typeof v === 'object') {
      return `{${Object.keys(v).filter(k => v[k] !== undefined).sort()
        .map(k => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
    }
    return JSON.stringify(v);
  }

  // Vergleich fuer "muss gesendet werden": gleiche ids mit gleichem Stand,
  // Reihenfolge egal.
  function sameState(a, b) {
    if ((a || []).length !== (b || []).length) return false;
    const m = new Map((b || []).map(it => [String(it.id), it]));
    for (const it of a || []) {
      const o = m.get(String(it.id));
      if (!o || stableStringify(o) !== stableStringify(it)) return false;
    }
    return true;
  }

  const api = { mergeItems, splitItems, makeTombstone, sameState, TOMBSTONE_TTL_MS };
  root.SyncMerge = api;
})(typeof self !== 'undefined' ? self : globalThis);
