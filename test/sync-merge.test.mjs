// WL-33: Zusammenfuehrung beim Sync — node --test test/sync-merge.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// sync-merge.js ist ein klassisches Browser-Skript (package.json: type module),
// deshalb in einem eigenen Kontext mit "self" ausfuehren wie im Browser.
const ctx = { self: {} };
vm.runInNewContext(readFileSync(new URL('../sync-merge.js', import.meta.url), 'utf8'), ctx);
const api = ctx.self.SyncMerge;
// Ergebnisse in diesen Kontext holen (deepEqual prueft Prototypen).
const plain = (fn) => (...args) => JSON.parse(JSON.stringify(fn(...args)));
const mergeItems = plain(api.mergeItems);
const splitItems = plain(api.splitItems);
const makeTombstone = plain(api.makeTombstone);
const { sameState, TOMBSTONE_TTL_MS } = api;

const NOW = 1_800_000_000_000;
const t = (id, extra = {}) => ({ id, tmdbId: Number(id.replace(/\D/g, '')) || 1, type: 'movie', title: id, watched: false, addedAt: NOW - 1000, updatedAt: NOW - 1000, ...extra });
const byId = (list) => Object.fromEntries(list.map(it => [it.id, it]));

test('Offline-Aenderung gewinnt gegen aelteren Server-Stand', () => {
  const local = [t('a1', { watched: true, updatedAt: NOW - 10 })];
  const remote = [t('a1', { updatedAt: NOW - 500 })];
  assert.equal(byId(mergeItems(local, remote, NOW)).a1.watched, true);
});

test('neuere Server-Fassung gewinnt; Gleichstand: Server', () => {
  const local = [t('a1', { watched: true, updatedAt: NOW - 500 }), t('b2', { title: 'lokal' })];
  const remote = [t('a1', { updatedAt: NOW - 10 }), t('b2', { title: 'server' })];
  const m = byId(mergeItems(local, remote, NOW));
  assert.equal(m.a1.watched, false);
  assert.equal(m.b2.title, 'server');
});

test('zwei Geraete mit verschiedenen Titeln: beide bleiben', () => {
  const m = mergeItems([t('a1')], [t('b2')], NOW);
  assert.deepEqual(m.map(i => i.id).sort(), ['a1', 'b2']);
});

test('leerer Server-Stand loescht lokal nichts', () => {
  const m = mergeItems([t('a1'), t('b2')], [], NOW);
  assert.equal(m.length, 2);
});

test('Loeschen auf Geraet A schlaegt unveraenderten Titel auf Geraet B', () => {
  const tomb = makeTombstone(t('a1'), NOW - 5);
  const m = mergeItems([t('a1')], [tomb], NOW);
  const { live, deleted } = splitItems(m);
  assert.equal(live.length, 0);
  assert.equal(deleted.length, 1);
});

test('spaetere Aenderung schlaegt aelteren Loesch-Marker', () => {
  const tomb = makeTombstone(t('a1'), NOW - 500);
  const m = mergeItems([t('a1', { watched: true, updatedAt: NOW - 5 })], [tomb], NOW);
  assert.equal(splitItems(m).live.length, 1);
});

test('Marker aelter als 30 Tage fallen weg, juengere bleiben', () => {
  const old = makeTombstone(t('a1'), NOW - TOMBSTONE_TTL_MS - 1);
  const young = makeTombstone(t('b2'), NOW - TOMBSTONE_TTL_MS + 1000);
  const m = mergeItems([], [old, young], NOW);
  assert.deepEqual(m.map(i => i.id), ['b2']);
});

test('alte Titel ohne updatedAt: addedAt zaehlt, sonst 0', () => {
  const local = [{ id: 'a1', title: 'lokal', addedAt: NOW - 10 }];
  const remote = [{ id: 'a1', title: 'server' }];
  assert.equal(mergeItems(local, remote, NOW)[0].title, 'lokal');
});

test('Shortlist-Kollision wird neu nummeriert, gesehene fallen raus, hoechstens 5', () => {
  const local = [t('a1', { shortlist: 0, updatedAt: NOW - 1 }), t('c3', { shortlist: 1 }), t('w9', { shortlist: 2, watched: true })];
  const remote = [t('b2', { shortlist: 0 }), t('d4', { shortlist: 1 }), t('e5', { shortlist: 2 }), t('f6', { shortlist: 3 })];
  const m = mergeItems(local, remote, NOW);
  const sl = m.filter(i => i.shortlist != null).sort((x, y) => x.shortlist - y.shortlist);
  assert.deepEqual(sl.map(i => i.shortlist), [0, 1, 2, 3, 4]);
  assert.equal(sl[0].id, 'a1');
  assert.equal(byId(m).w9.shortlist, null);
});

test('derselbe TMDB-Titel auf zwei Geraeten angelegt: einer bleibt, auf beiden derselbe', () => {
  const x = { id: 'x1', tmdbId: 42, type: 'movie', addedAt: NOW - 5, updatedAt: NOW - 5 };
  const y = { id: 'y1', tmdbId: 42, type: 'movie', addedAt: NOW - 5, updatedAt: NOW - 5 };
  assert.deepEqual(mergeItems([x], [y], NOW).map(i => i.id), ['x1']);
  assert.deepEqual(mergeItems([y], [x], NOW).map(i => i.id), ['x1']);
});

test('Eingaben bleiben unveraendert', () => {
  const local = [t('a1', { shortlist: 3 })];
  const snapshot = JSON.stringify(local);
  mergeItems(local, [], NOW);
  assert.equal(JSON.stringify(local), snapshot);
});

test('sameState ignoriert Reihenfolge der Titel und Schluessel', () => {
  assert.equal(sameState([{ id: 'a', x: 1, y: 2 }, { id: 'b' }], [{ id: 'b' }, { y: 2, x: 1, id: 'a' }]), true);
  assert.equal(sameState([{ id: 'a', x: 1 }], [{ id: 'a', x: 2 }]), false);
  assert.equal(sameState([{ id: 'a' }], []), false);
});

test('ungueltige Eintraege werden ignoriert', () => {
  assert.deepEqual(mergeItems([null, { title: 'ohne id' }], [undefined, t('a1')], NOW).map(i => i.id), ['a1']);
});
