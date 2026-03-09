/* ============================================
   WATCHLIST — App Logic (v2: auto-providers)
   ============================================ */

// ---- Configuration ----
const TMDB_API_KEY = '1c0da1f5ff6aace3b668f89321b5c601';
const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG = 'https://image.tmdb.org/t/p';
const STORAGE_KEY = 'watchlist_items';
const WATCH_REGION = 'DE';

// ---- Sync Configuration ----
const SYNC_URL = 'https://watchlist-sync.escholly.workers.dev/sync';
let syncStatus = 'idle'; // idle | syncing | synced | error

// Read sync key: URL hash (#sync=KEY) on first visit, then persisted in localStorage
function getSyncKey() {
  const hash = window.location.hash;
  const match = hash.match(/sync=([^&]+)/);
  if (match) {
    // Hash present — persist to localStorage for future launches (e.g. homescreen)
    localStorage.setItem('watchlist_sync_key', match[1]);
    return match[1];
  }
  // No hash — try localStorage (homescreen launch, cache cleared hash)
  return localStorage.getItem('watchlist_sync_key');
}
const SYNC_KEY = getSyncKey();
const SYNC_ENABLED = !!SYNC_KEY;

// ---- Streaming Services with TMDB provider IDs ----
const SERVICES = [
  { id: 'netflix',   name: 'Netflix',     color: '#e50914', tmdbIds: [8] },
  { id: 'prime',     name: 'Prime Video', color: '#00a8e1', tmdbIds: [9, 119] },
  { id: 'disney',    name: 'Disney+',     color: '#113ccf', tmdbIds: [337] },
  { id: 'apple',     name: 'Apple TV+',   color: '#555',    tmdbIds: [350] },
  { id: 'sky',       name: 'Sky',         color: '#002f5f', tmdbIds: [30, 1773, 29] },
  { id: 'hbo',       name: 'HBO Max',     color: '#b91ad1', tmdbIds: [384, 1899] },
  { id: 'paramount', name: 'Paramount+',  color: '#0064ff', tmdbIds: [531] },
  { id: 'magenta',   name: 'Magenta TV',  color: '#e20074', tmdbIds: [178] },
  { id: 'joyne',     name: 'Joyne',       color: '#ff6600', tmdbIds: [421] },
  { id: 'ard',       name: 'ARD',         color: '#004e8a', tmdbIds: [219] },
  { id: 'zdf',       name: 'ZDF',         color: '#fa7d19', tmdbIds: [537, 536] },
  { id: 'rtl',       name: 'RTL+',        color: '#e3001b', tmdbIds: [298, 1771] },
];

// Build reverse lookup: tmdbProviderId -> serviceId
const PROVIDER_MAP = {};
SERVICES.forEach(svc => {
  svc.tmdbIds.forEach(pid => { PROVIDER_MAP[pid] = svc.id; });
});

// ---- State ----
let items = [];
let activeFilter = 'all';
let activeService = null;
let selectedTmdb = null;
let selectedService = null;
let availableServices = [];
let searchTimeout = null;

// ---- DOM ----
const $watchlist = document.getElementById('watchlist');
const $emptyState = document.getElementById('emptyState');
const $filterBar = document.getElementById('filterBar');
const $addModal = document.getElementById('addModal');
const $detailModal = document.getElementById('detailModal');
const $searchInput = document.getElementById('searchInput');
const $searchClear = document.getElementById('searchClear');
const $searchResults = document.getElementById('searchResults');
const $serviceSelect = document.getElementById('serviceSelect');
const $selectedTitle = document.getElementById('selectedTitle');
const $serviceGrid = document.getElementById('serviceGrid');
const $btnSave = document.getElementById('btnSave');

// ---- Init ----
async function init() {
  loadItemsLocal();
  renderFilterBar();
  renderWatchlist();
  bindEvents();
  // Sync from server (non-blocking)
  await pullFromServer();
}

// ---- Storage (Local) ----
function loadItemsLocal() {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    items = data ? JSON.parse(data) : [];
  } catch {
    items = [];
  }
}

function saveItemsLocal() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

// ---- Sync ----
function setSyncStatus(status) {
  syncStatus = status;
  const el = document.getElementById('syncIndicator');
  if (!el) return;
  el.className = 'sync-indicator ' + status;
  el.textContent = { idle: '', syncing: '↻', synced: '✓', error: '!' }[status] || '';
  if (status === 'synced') {
    setTimeout(() => { if (syncStatus === 'synced') setSyncStatus('idle'); }, 2000);
  }
}

async function pushToServer() {
  if (!SYNC_ENABLED) return;
  try {
    setSyncStatus('syncing');
    const res = await fetch(SYNC_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': SYNC_KEY },
      body: JSON.stringify({ items }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setSyncStatus('synced');
  } catch (err) {
    console.error('Sync push error:', err);
    setSyncStatus('error');
  }
}

async function pullFromServer() {
  if (!SYNC_ENABLED) return;
  try {
    setSyncStatus('syncing');
    const res = await fetch(SYNC_URL, {
      headers: { 'X-API-Key': SYNC_KEY },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const remote = data.items || [];

    if (remote.length === 0 && items.length > 0) {
      // Server empty, push local data up
      await pushToServer();
    } else if (remote.length > 0) {
      // Merge: remote wins for conflicts (by tmdbId+type), keep local-only items
      const merged = mergeItems(items, remote);
      items = merged;
      saveItemsLocal();
      renderFilterBar();
      renderWatchlist();
      setSyncStatus('synced');
    } else {
      setSyncStatus('synced');
    }
  } catch (err) {
    console.error('Sync pull error:', err);
    setSyncStatus('error');
  }
}

function mergeItems(local, remote) {
  // Build map by unique key (tmdbId + type)
  const map = new Map();

  // Local items first
  local.forEach(item => {
    const key = `${item.tmdbId}_${item.type}`;
    map.set(key, item);
  });

  // Remote items overwrite (server = source of truth) but keep newer local changes
  remote.forEach(item => {
    const key = `${item.tmdbId}_${item.type}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, item);
    } else {
      // Keep whichever was modified more recently
      const localTime = existing.updatedAt || existing.addedAt || 0;
      const remoteTime = item.updatedAt || item.addedAt || 0;
      if (remoteTime >= localTime) {
        map.set(key, item);
      }
    }
  });

  return [...map.values()];
}

function saveItems() {
  // Add updatedAt timestamp for merge tracking
  items.forEach(item => { item.updatedAt = Date.now(); });
  saveItemsLocal();
  pushToServer(); // async, non-blocking
}

function exportData() {
  return JSON.stringify(items, null, 2);
}

function importData(json) {
  try {
    const data = JSON.parse(json);
    if (Array.isArray(data)) {
      items = data;
      saveItems();
      renderFilterBar();
      renderWatchlist();
      return true;
    }
  } catch {}
  return false;
}

// ---- TMDB API ----
async function searchTmdb(query) {
  if (!TMDB_API_KEY || !query.trim()) return [];
  const url = `${TMDB_BASE}/search/multi?api_key=${TMDB_API_KEY}&language=de-DE&query=${encodeURIComponent(query)}&page=1&include_adult=false`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    return (data.results || [])
      .filter(r => r.media_type === 'movie' || r.media_type === 'tv')
      .slice(0, 8);
  } catch (err) {
    console.error('TMDB search error:', err);
    return [];
  }
}

async function fetchProviders(tmdbId, mediaType) {
  const url = `${TMDB_BASE}/${mediaType}/${tmdbId}/watch/providers?api_key=${TMDB_API_KEY}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    const de = data.results?.[WATCH_REGION];
    if (!de) return { flat: [], rent: [], buy: [] };

    const mapProviders = (list) => {
      if (!list) return [];
      const mapped = new Set();
      list.forEach(p => {
        const svcId = PROVIDER_MAP[p.provider_id];
        if (svcId) mapped.add(svcId);
      });
      return [...mapped];
    };

    return {
      flat: mapProviders(de.flatrate),
      rent: mapProviders(de.rent),
      buy: mapProviders(de.buy),
    };
  } catch (err) {
    console.error('Provider fetch error:', err);
    return { flat: [], rent: [], buy: [] };
  }
}

function tmdbPoster(path, size = 'w342') {
  return path ? `${TMDB_IMG}/${size}${path}` : null;
}

function tmdbBackdrop(path) {
  return path ? `${TMDB_IMG}/w780${path}` : null;
}

function getTitle(item) {
  return item.title || item.name || 'Unbekannt';
}

function getYear(item) {
  const date = item.release_date || item.first_air_date || '';
  return date ? date.substring(0, 4) : '';
}

function getType(item) {
  return item.media_type === 'tv' ? 'Serie' : 'Film';
}

function getTypeTag(item) {
  return item.media_type === 'tv' ? 'tv' : 'movie';
}

// ---- Render: Filter Bar ----
function renderFilterBar() {
  const usedServices = [...new Set(items.map(i => i.serviceId))];
  const existingServiceChips = $filterBar.querySelectorAll('.service-chip');
  existingServiceChips.forEach(c => c.remove());

  usedServices.forEach(svcId => {
    const svc = SERVICES.find(s => s.id === svcId);
    if (!svc) return;
    const chip = document.createElement('button');
    chip.className = 'filter-chip service-chip';
    chip.dataset.service = svc.id;
    chip.style.setProperty('--chip-color', svc.color);
    chip.textContent = svc.name;
    if (activeService === svc.id) chip.classList.add('active');
    $filterBar.appendChild(chip);
  });
}

// ---- Render: Watchlist ----
function renderWatchlist() {
  $watchlist.querySelectorAll('.card, .count-badge').forEach(el => el.remove());

  let filtered = items;

  if (activeFilter === 'movie') {
    filtered = filtered.filter(i => i.type === 'movie');
  } else if (activeFilter === 'tv') {
    filtered = filtered.filter(i => i.type === 'tv');
  }

  if (activeService) {
    filtered = filtered.filter(i => i.serviceId === activeService);
  }

  // Sort: unwatched first, then by date added (newest first)
  filtered.sort((a, b) => {
    if (a.watched !== b.watched) return a.watched ? 1 : -1;
    return (b.addedAt || 0) - (a.addedAt || 0);
  });

  if (filtered.length === 0 && items.length === 0) {
    $emptyState.classList.remove('hidden');
  } else {
    $emptyState.classList.add('hidden');

    if (filtered.length === 0) {
      const badge = document.createElement('div');
      badge.className = 'count-badge';
      badge.textContent = 'Keine Ergebnisse für diesen Filter';
      $watchlist.appendChild(badge);
    } else {
      const unwatched = filtered.filter(i => !i.watched).length;
      const badge = document.createElement('div');
      badge.className = 'count-badge';
      badge.textContent = `${unwatched} offen · ${filtered.length} gesamt`;
      $watchlist.appendChild(badge);
    }

    filtered.forEach(item => {
      $watchlist.appendChild(createCard(item));
    });
  }
}

function createCard(item) {
  const card = document.createElement('div');
  card.className = 'card' + (item.watched ? ' watched' : '');
  card.dataset.id = item.id;

  const svc = SERVICES.find(s => s.id === item.serviceId);

  card.innerHTML = `
    ${item.poster
      ? `<img class="card-poster" src="${tmdbPoster(item.poster)}" alt="${item.title}" loading="lazy">`
      : `<div class="card-no-poster">🎬</div>`
    }
    <div class="card-overlay">
      <div class="card-title">${item.title}</div>
      <div class="card-meta">
        <span class="card-year">${item.year}</span>
        <span class="card-type">${item.type === 'tv' ? 'Serie' : 'Film'}</span>
      </div>
    </div>
    ${svc ? `<div class="service-badge" style="background:${svc.color}">${svc.name}</div>` : ''}
  `;

  card.addEventListener('click', () => openDetail(item));
  return card;
}

// ---- Render: Search Results ----
function renderSearchResults(results) {
  if (results === null) {
    $searchResults.innerHTML = '<div class="search-loading">Suche...</div>';
    return;
  }

  if (results.length === 0) {
    $searchResults.innerHTML = '<div class="search-empty">Keine Ergebnisse</div>';
    return;
  }

  $searchResults.innerHTML = results.map(r => `
    <div class="search-result" data-id="${r.id}" data-type="${r.media_type}">
      <img class="result-poster"
           src="${tmdbPoster(r.poster_path, 'w92') || ''}"
           alt=""
           onerror="this.style.background='#222'">
      <div class="result-info">
        <div class="result-title">${getTitle(r)}</div>
        <div class="result-meta">${getYear(r)} · ${getType(r)}</div>
        ${r.overview ? `<div class="result-overview">${r.overview}</div>` : ''}
      </div>
    </div>
  `).join('');

  $searchResults.querySelectorAll('.search-result').forEach(el => {
    el.addEventListener('click', () => {
      const tmdbId = parseInt(el.dataset.id);
      const result = results.find(r => r.id === tmdbId);
      if (result) selectResult(result);
    });
  });
}

// ---- Render: Service Grid with Availability ----
function renderServiceGrid(available) {
  const flatSet = new Set(available?.flat || []);
  const allAvailable = new Set([
    ...(available?.flat || []),
    ...(available?.rent || []),
    ...(available?.buy || []),
  ]);

  $serviceGrid.innerHTML = SERVICES.map(svc => {
    const isFlat = flatSet.has(svc.id);
    const isAvail = allAvailable.has(svc.id);
    const classes = ['service-btn'];
    if (isFlat) classes.push('available');
    else if (!isAvail && allAvailable.size > 0) classes.push('unavailable');

    return `<button class="${classes.join(' ')}" data-service="${svc.id}" style="--svc-color:${svc.color}">
      ${svc.name}
    </button>`;
  }).join('');

  $serviceGrid.querySelectorAll('.service-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $serviceGrid.querySelectorAll('.service-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      selectedService = btn.dataset.service;
      $btnSave.disabled = false;
    });
  });

  // Auto-select if only one flat service available
  if (flatSet.size === 1) {
    const autoId = [...flatSet][0];
    const autoBtn = $serviceGrid.querySelector(`[data-service="${autoId}"]`);
    if (autoBtn) {
      autoBtn.classList.add('selected');
      selectedService = autoId;
      $btnSave.disabled = false;
    }
  }
}

// ---- Select TMDB Result ----
async function selectResult(result) {
  selectedTmdb = result;
  selectedService = null;
  availableServices = [];

  // Show service selection
  $searchResults.classList.add('hidden');
  $serviceSelect.classList.remove('hidden');
  document.querySelector('.search-wrapper').classList.add('hidden');

  $selectedTitle.innerHTML = `
    <img src="${tmdbPoster(result.poster_path, 'w92') || ''}" alt="">
    <div>
      <div class="selected-title-text">${getTitle(result)}</div>
      <div class="selected-title-sub">${getYear(result)} · ${getType(result)}</div>
    </div>
  `;

  // Show loading state for availability
  const availContainer = document.getElementById('availabilityInfo');
  if (availContainer) availContainer.remove();
  const loadingEl = document.createElement('div');
  loadingEl.id = 'availabilityInfo';
  loadingEl.className = 'availability-loading';
  loadingEl.innerHTML = '<div class="spinner"></div> Verfügbarkeit wird geprüft...';
  $serviceGrid.parentNode.insertBefore(loadingEl, $serviceGrid);

  // Render grid without availability first
  renderServiceGrid({});
  $btnSave.disabled = true;

  // Fetch providers
  const providers = await fetchProviders(result.id, result.media_type);
  availableServices = providers;

  // Update availability info
  const infoEl = document.getElementById('availabilityInfo');
  if (infoEl) {
    if (providers.flat.length > 0) {
      const names = providers.flat.map(id => SERVICES.find(s => s.id === id)?.name).filter(Boolean);
      infoEl.className = 'availability-info';
      infoEl.innerHTML = `✓ Im Abo bei: ${names.join(', ')}`;
    } else if (providers.rent.length > 0 || providers.buy.length > 0) {
      infoEl.className = 'availability-info not-found';
      infoEl.innerHTML = '⚡ Nicht im Flatrate-Abo, aber zum Leihen/Kaufen verfügbar';
    } else {
      infoEl.className = 'availability-info not-found';
      infoEl.innerHTML = '⚠ Keine Streaming-Verfügbarkeit in DE gefunden';
    }
  }

  // Re-render grid with availability
  renderServiceGrid(providers);
}

// ---- Add Item ----
function addItem() {
  if (!selectedTmdb || !selectedService) return;

  // Check for duplicate
  const exists = items.find(i => i.tmdbId === selectedTmdb.id && i.type === getTypeTag(selectedTmdb));
  if (exists) {
    closeAddModal();
    openDetail(exists);
    return;
  }

  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
    tmdbId: selectedTmdb.id,
    title: getTitle(selectedTmdb),
    year: getYear(selectedTmdb),
    type: getTypeTag(selectedTmdb),
    poster: selectedTmdb.poster_path,
    backdrop: selectedTmdb.backdrop_path,
    overview: selectedTmdb.overview || '',
    rating: selectedTmdb.vote_average ? Math.round(selectedTmdb.vote_average * 10) / 10 : null,
    serviceId: selectedService,
    watched: false,
    addedAt: Date.now(),
    providers: availableServices,
  };

  items.unshift(item);
  saveItems();
  closeAddModal();
  renderFilterBar();
  renderWatchlist();
}

// ---- Detail View ----
async function openDetail(item) {
  const svc = SERVICES.find(s => s.id === item.serviceId);
  const $backdrop = document.getElementById('detailBackdrop');
  const $content = document.getElementById('detailContent');

  if (item.backdrop) {
    $backdrop.style.backgroundImage = `url(${tmdbBackdrop(item.backdrop)})`;
  } else if (item.poster) {
    $backdrop.style.backgroundImage = `url(${tmdbPoster(item.poster, 'w780')})`;
  } else {
    $backdrop.style.backgroundImage = 'none';
    $backdrop.style.background = 'linear-gradient(135deg, #222, #333)';
  }

  const ratingPct = item.rating ? Math.round(item.rating * 10) : null;

  $content.innerHTML = `
    ${svc ? `<div class="detail-service-badge" style="background:${svc.color}">${svc.name}</div>` : ''}
    <h2 class="detail-title">${item.title}</h2>
    <div class="detail-meta">
      ${ratingPct ? `<span class="detail-match">${ratingPct}% Match</span>` : ''}
      <span>${item.year}</span>
      <span>·</span>
      <span>${item.type === 'tv' ? 'Serie' : 'Film'}</span>
    </div>
    ${item.overview ? `<p class="detail-overview">${item.overview}</p>` : ''}
    <div id="detailProviders"></div>
    <div class="detail-actions">
      <button class="btn-watched" data-id="${item.id}">
        ${item.watched ? '↩ Nicht gesehen' : '✓ Geschaut'}
      </button>
      <button class="btn-remove" data-id="${item.id}">Entfernen</button>
    </div>
  `;

  // Bind actions
  $content.querySelector('.btn-watched').addEventListener('click', () => {
    item.watched = !item.watched;
    saveItems();
    closeDetailModal();
    renderWatchlist();
  });

  $content.querySelector('.btn-remove').addEventListener('click', () => {
    items = items.filter(i => i.id !== item.id);
    saveItems();
    closeDetailModal();
    renderFilterBar();
    renderWatchlist();
  });

  $detailModal.classList.add('open');

  // Fetch fresh providers in background
  const $providers = document.getElementById('detailProviders');
  $providers.innerHTML = '<div class="availability-loading"><div class="spinner"></div> Verfügbarkeit prüfen...</div>';

  const providers = await fetchProviders(item.tmdbId, item.type);
  item.providers = providers;
  saveItems();

  // Render provider badges
  let providerHtml = '';

  if (providers.flat.length > 0) {
    providerHtml += '<div class="detail-provider-type">Im Abo verfügbar:</div><div class="detail-providers">';
    providers.flat.forEach(svcId => {
      const s = SERVICES.find(x => x.id === svcId);
      if (s) {
        const isCurrent = svcId === item.serviceId;
        providerHtml += `<div class="detail-provider-badge" style="background:${s.color}${isCurrent ? '' : ';opacity:0.7'}">${s.name}</div>`;
      }
    });
    providerHtml += '</div>';
  }

  // Check if current service is no longer available
  if (providers.flat.length > 0 && !providers.flat.includes(item.serviceId)) {
    const altNames = providers.flat.map(id => SERVICES.find(s => s.id === id)?.name).filter(Boolean);
    providerHtml += `<div class="availability-info not-found" style="margin-top:8px">⚠ Nicht mehr bei ${svc?.name || 'deinem Dienst'} im Abo! Verfügbar bei: ${altNames.join(', ')}</div>`;
  } else if (providers.flat.length === 0 && providers.rent.length === 0 && providers.buy.length === 0) {
    providerHtml += `<div class="availability-info not-found" style="margin-top:8px">⚠ Aktuell keine Streaming-Verfügbarkeit in DE gefunden</div>`;
  }

  $providers.innerHTML = providerHtml;
}

function closeDetailModal() {
  $detailModal.classList.remove('open');
}

// ---- Add Modal ----
function openAddModal() {
  resetAddModal();
  $addModal.classList.add('open');
  setTimeout(() => $searchInput.focus(), 300);
}

function closeAddModal() {
  $addModal.classList.remove('open');
  resetAddModal();
}

function resetAddModal() {
  $searchInput.value = '';
  $searchClear.classList.add('hidden');
  $searchResults.innerHTML = '';
  $searchResults.classList.remove('hidden');
  $serviceSelect.classList.add('hidden');
  document.querySelector('.search-wrapper').classList.remove('hidden');
  const availEl = document.getElementById('availabilityInfo');
  if (availEl) availEl.remove();
  selectedTmdb = null;
  selectedService = null;
  availableServices = [];
}

// ---- Events ----
function bindEvents() {
  document.getElementById('btnAdd').addEventListener('click', openAddModal);

  document.getElementById('modalClose').addEventListener('click', closeAddModal);
  $addModal.addEventListener('click', (e) => {
    if (e.target === $addModal) closeAddModal();
  });
  $detailModal.addEventListener('click', (e) => {
    if (e.target === $detailModal) closeDetailModal();
  });

  // Search input
  $searchInput.addEventListener('input', (e) => {
    const q = e.target.value;
    $searchClear.classList.toggle('hidden', !q);

    clearTimeout(searchTimeout);
    if (q.length < 2) {
      $searchResults.innerHTML = '';
      return;
    }

    renderSearchResults(null);
    searchTimeout = setTimeout(async () => {
      const results = await searchTmdb(q);
      renderSearchResults(results);
    }, 400);
  });

  $searchClear.addEventListener('click', () => {
    $searchInput.value = '';
    $searchClear.classList.add('hidden');
    $searchResults.innerHTML = '';
    $searchInput.focus();
  });

  $btnSave.addEventListener('click', addItem);

  // Filter chips
  $filterBar.addEventListener('click', (e) => {
    const chip = e.target.closest('.filter-chip');
    if (!chip) return;

    if (chip.dataset.filter) {
      activeFilter = chip.dataset.filter;
      $filterBar.querySelectorAll('[data-filter]').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      activeService = null;
      $filterBar.querySelectorAll('.service-chip').forEach(c => c.classList.remove('active'));
    } else if (chip.dataset.service) {
      if (activeService === chip.dataset.service) {
        activeService = null;
        chip.classList.remove('active');
      } else {
        activeService = chip.dataset.service;
        $filterBar.querySelectorAll('.service-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
      }
    }

    renderWatchlist();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if ($detailModal.classList.contains('open')) closeDetailModal();
      else if ($addModal.classList.contains('open')) closeAddModal();
    }
  });
}

// ---- Boot ----
init();
