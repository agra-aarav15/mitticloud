/* ============================================================
   MittiCloud frontend — vanilla JS, no frameworks, no build step
   Tabs: Status (polls /api/status) · Photos (vault) · Files (server)
   ============================================================ */
'use strict';

/* ------------------------------------------------------------
   Helpers
   ------------------------------------------------------------ */

const $ = (sel) => document.querySelector(sel);

const TABS = ['status', 'photos', 'files'];

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function humanizeBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n;
  let i = -1;
  do { v /= 1024; i += 1; } while (v >= 1024 && i < units.length - 1);
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function humanizeUptime(sec) {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/* ------------------------------------------------------------
   Toast
   ------------------------------------------------------------ */

let toastTimer = null;

function toast(message, type = 'error') {
  const el = $('#toast');
  if (!el) return;
  el.textContent = message;
  el.classList.remove('toast-success');
  if (type === 'success') el.classList.add('toast-success');
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4000);
}

/* ------------------------------------------------------------
   Fetch helper — parses JSON, surfaces { error } via toast
   ------------------------------------------------------------ */

async function api(url, opts = {}) {
  const { silent = false, ...fetchOpts } = opts;
  let res;
  try {
    res = await fetch(url, fetchOpts);
  } catch (err) {
    if (!silent) toast('Cannot reach the MittiCloud server.');
    throw err;
  }
  let body = {};
  try {
    body = await res.json();
  } catch (_) { /* empty or non-JSON body */ }
  if (!res.ok) {
    const message = body && body.error
      ? String(body.error)
      : `Request failed (HTTP ${res.status})`;
    if (!silent) toast(message);
    const e = new Error(message);
    e.status = res.status;
    throw e;
  }
  return body;
}

/* ------------------------------------------------------------
   Shared state (one slice per tab)
   ------------------------------------------------------------ */

const state = {
  active: 'status',
  status: { data: null, demoDismissed: false },
  photos: { items: [], loaded: false, uploading: false },
  files: { path: '', entries: [], loaded: false },
};

/* ------------------------------------------------------------
   Tabs (ARIA tabs pattern + arrow-key navigation)
   ------------------------------------------------------------ */

function selectTab(name, moveFocus = false) {
  state.active = name;
  for (const t of TABS) {
    const selected = t === name;
    const tab = $(`#tab-${t}`);
    const panel = $(`#panel-${t}`);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    panel.hidden = !selected;
  }
  if (moveFocus) $(`#tab-${name}`).focus();

  if (name === 'status') refreshStatus(false);
  if (name === 'photos' && !state.photos.loaded) refreshPhotos();
  if (name === 'files' && !state.files.loaded) refreshFiles();
}

function initTabs() {
  for (const t of TABS) {
    $(`#tab-${t}`).addEventListener('click', () => selectTab(t));
  }
  document.querySelector('.tabs').addEventListener('keydown', (e) => {
    const idx = TABS.indexOf(state.active);
    let next = null;
    if (e.key === 'ArrowRight') next = TABS[(idx + 1) % TABS.length];
    else if (e.key === 'ArrowLeft') next = TABS[(idx - 1 + TABS.length) % TABS.length];
    else if (e.key === 'Home') next = TABS[0];
    else if (e.key === 'End') next = TABS[TABS.length - 1];
    if (next) {
      e.preventDefault();
      selectTab(next, true);
    }
  });
}

/* ------------------------------------------------------------
   Status tab
   ------------------------------------------------------------ */

const RING_CIRCUMFERENCE = 2 * Math.PI * 52; // r = 52 in the SVG ring

function setRing(level) {
  const arc = $('#battery-arc');
  const label = $('#battery-level-text');
  arc.style.strokeDasharray = String(RING_CIRCUMFERENCE);
  if (typeof level === 'number') {
    const clamped = Math.max(0, Math.min(100, level));
    arc.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - clamped / 100));
    label.textContent = `${clamped}%`;
    arc.classList.toggle('ring-low', clamped <= 20);
  } else {
    arc.style.strokeDashoffset = String(RING_CIRCUMFERENCE);
    label.textContent = '–';
    arc.classList.remove('ring-low');
  }
}

function renderStatus() {
  const d = state.status.data;
  if (!d) return;

  if (d.version) $('#version-badge').textContent = `v${d.version}`;

  const battery = d.battery || {};
  const storage = d.storage || {};

  // Battery ring + charging bolt
  setRing(typeof battery.level === 'number' ? battery.level : null);
  $('#battery-bolt').hidden = !battery.charging;
  $('#battery-charging').textContent = battery.charging ? '⚡ Charging' : 'On battery';
  $('#battery-temp').textContent = typeof battery.temperature === 'number'
    ? `${battery.temperature.toFixed(1)}°C`
    : 'Temperature unknown';
  $('#battery-mock-pill').hidden = !battery.mocked;

  // Storage bar
  const pct = typeof storage.usedPct === 'number'
    ? Math.max(0, Math.min(100, storage.usedPct))
    : null;
  $('#storage-fill').style.width = pct === null ? '0%' : `${pct}%`;
  const bar = $('#storage-bar');
  bar.setAttribute('aria-valuenow', pct === null ? '0' : String(Math.round(pct)));
  $('#storage-label').textContent = pct === null
    ? 'Storage info unavailable on this device.'
    : `${pct.toFixed(1)}% used — ${humanizeBytes(storage.free)} free of ${humanizeBytes(storage.total)}`;
  $('#storage-mock-pill').hidden = !storage.mocked;

  // Device + uptime
  const device = d.device || {};
  $('#device-line').textContent = device.termux
    ? `✅ Termux detected · ${device.platform || 'unknown platform'}`
    : `🖥️ Demo mode · ${device.platform || 'unknown platform'}`;
  $('#uptime-line').textContent = `Server uptime: ${humanizeUptime(d.uptimeSec)}`;

  // Tunnel
  const tunnel = d.tunnel || {};
  $('#tunnel-mode').textContent = tunnel.mode ? `Mode: ${tunnel.mode}` : 'Mode: unknown';
  $('#tunnel-hint').textContent = tunnel.hint || '';

  // Demo banner — show while anything is mocked, unless dismissed
  const anyMocked = Boolean(battery.mocked || storage.mocked);
  const banner = $('#demo-banner');
  if (!anyMocked) {
    state.status.demoDismissed = false;
    banner.hidden = true;
  } else {
    banner.hidden = state.status.demoDismissed;
  }
}

async function refreshStatus(silent) {
  try {
    const data = await api('/api/status', { silent: Boolean(silent) });
    state.status.data = data;
    renderStatus();
  } catch (_) { /* toast already shown (unless silent poll) */ }
}

function initStatus() {
  $('#banner-dismiss').addEventListener('click', () => {
    state.status.demoDismissed = true;
    $('#demo-banner').hidden = true;
  });
}

/* ------------------------------------------------------------
   Photos tab
   ------------------------------------------------------------ */

function renderPhotos() {
  const grid = $('#photos-grid');
  const photos = state.photos.items;

  if (!photos.length) {
    grid.innerHTML = '<p class="empty">No photos yet — tap “⬆️ Upload Photos”.</p>';
    return;
  }

  grid.innerHTML = photos.map((p) => {
    const name = escapeHtml(p.name);
    const url = escapeHtml(p.url);
    const encodedPath = encodeURIComponent(p.path);
    return `
      <figure class="photo-tile">
        <a href="${url}" target="_blank" rel="noopener noreferrer">
          <img src="${url}" alt="${name}" loading="lazy" decoding="async">
        </a>
        <figcaption>
          <span class="photo-name" title="${name}">${name}</span>
          <span class="photo-size">${humanizeBytes(p.size)}</span>
        </figcaption>
        <button class="photo-delete" data-path="${encodedPath}" data-name="${name}"
                aria-label="Delete photo ${name}">🗑️</button>
      </figure>`;
  }).join('');
}

async function refreshPhotos() {
  const grid = $('#photos-grid');
  if (!state.photos.loaded) grid.innerHTML = '<p class="empty">Loading photos…</p>';
  try {
    const data = await api('/api/photos');
    state.photos.items = Array.isArray(data.photos) ? data.photos : [];
    state.photos.loaded = true;
    renderPhotos();
  } catch (_) {
    if (!state.photos.loaded) grid.innerHTML = '<p class="empty">Could not load photos.</p>';
  }
}

function setUploading(uploading) {
  state.photos.uploading = uploading;
  $('#upload-state').hidden = !uploading;
  $('#photo-upload-btn').disabled = uploading;
  $('#photo-refresh').disabled = uploading;
}

async function uploadPhotos() {
  if (state.photos.uploading) return;
  const input = $('#photo-input');
  const files = Array.from(input.files || []);
  if (!files.length) return;

  const form = new FormData();
  for (const f of files) form.append('photos', f, f.name);

  setUploading(true);
  try {
    const data = await api('/api/photos/upload', { method: 'POST', body: form });
    const n = Array.isArray(data.uploaded) ? data.uploaded.length : files.length;
    toast(`Uploaded ${n} photo${n === 1 ? '' : 's'}.`, 'success');
    input.value = '';
    await refreshPhotos();
  } catch (_) { /* toast already shown */ } finally {
    setUploading(false);
  }
}

async function deletePhoto(relPath, name) {
  if (!confirm(`Delete photo "${name}"? This cannot be undone.`)) return;
  try {
    await api(`/api/photos?path=${encodeURIComponent(relPath)}`, { method: 'DELETE' });
    toast(`Deleted ${name}.`, 'success');
    await refreshPhotos();
  } catch (_) { /* toast already shown */ }
}

function initPhotos() {
  $('#photo-upload-btn').addEventListener('click', () => $('#photo-input').click());
  $('#photo-input').addEventListener('change', uploadPhotos);
  $('#photo-refresh').addEventListener('click', refreshPhotos);

  $('#photos-grid').addEventListener('click', (e) => {
    const btn = e.target.closest('.photo-delete');
    if (!btn) return;
    deletePhoto(decodeURIComponent(btn.dataset.path), btn.dataset.name);
  });
}

/* ------------------------------------------------------------
   Files tab
   ------------------------------------------------------------ */

function joinPath(dir, name) {
  return dir ? `${dir}/${name}` : name;
}

function parentPath(path) {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

function renderBreadcrumbs() {
  const nav = $('#files-breadcrumbs');
  const path = state.files.path;
  let html = `<button class="crumb" data-path="" aria-label="Go to root">🏠 Root</button>`;
  let acc = '';
  for (const part of (path ? path.split('/') : [])) {
    acc = acc ? `${acc}/${part}` : part;
    const current = acc === path;
    html += `<span class="crumb-sep" aria-hidden="true">/</span>`
      + `<button class="crumb${current ? ' current' : ''}" data-path="${encodeURIComponent(acc)}"`
      + `${current ? ' aria-current="location"' : ''}>${escapeHtml(part)}</button>`;
  }
  nav.innerHTML = html;
}

function renderFiles() {
  renderBreadcrumbs();
  $('#files-up').disabled = !state.files.path;

  const list = $('#files-list');
  const entries = [...state.files.entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' });
  });

  if (!entries.length) {
    list.innerHTML = '<p class="empty">This folder is empty.</p>';
    return;
  }

  list.innerHTML = entries.map((entry) => {
    const full = joinPath(state.files.path, entry.name);
    const encoded = encodeURIComponent(full);
    const name = escapeHtml(entry.name);
    const isDir = entry.type === 'dir';
    const icon = isDir ? '📁' : '📄';
    const meta = isDir ? 'folder' : humanizeBytes(entry.size);
    const opener = isDir
      ? `<button class="file-open" data-dir="${encoded}">${icon} <span class="file-name">${name}</span></button>`
      : `<span class="file-open">${icon} <span class="file-name">${name}</span></span>`;
    const download = isDir
      ? '<span class="icon-btn" aria-hidden="true"></span>'
      : `<a class="icon-btn" href="/api/files/download?path=${encoded}" download
             aria-label="Download ${name}" title="Download">⬇️</a>`;
    return `
      <div class="file-row">
        ${opener}
        <span class="file-meta">${meta}</span>
        ${download}
        <button class="icon-btn file-delete" data-path="${encoded}" data-name="${name}"
                data-dir="${isDir ? 'true' : 'false'}"
                aria-label="Delete ${isDir ? 'folder' : 'file'} ${name}" title="Delete">🗑️</button>
      </div>`;
  }).join('');
}

async function refreshFiles() {
  const list = $('#files-list');
  if (!state.files.loaded) list.innerHTML = '<p class="empty">Loading files…</p>';
  try {
    const data = await api(`/api/files?path=${encodeURIComponent(state.files.path)}`);
    if (typeof data.path === 'string') state.files.path = data.path;
    state.files.entries = Array.isArray(data.entries) ? data.entries : [];
    state.files.loaded = true;
    renderFiles();
  } catch (_) {
    if (!state.files.loaded) list.innerHTML = '<p class="empty">Could not load files.</p>';
  }
}

function navigateTo(path) {
  state.files.path = path;
  refreshFiles();
}

async function removeEntry(relPath, name, force) {
  const query = `path=${encodeURIComponent(relPath)}${force ? '&force=true' : ''}`;
  try {
    await api(`/api/files?${query}`, { method: 'DELETE' });
    toast(`Deleted ${name}.`, 'success');
    await refreshFiles();
  } catch (err) {
    // Backend refuses non-empty dirs unless force=true — offer to force.
    if (!force && /not\s*empty/i.test(err.message)) {
      if (confirm(`"${name}" is not empty. Delete it and EVERYTHING inside it?`)) {
        await removeEntry(relPath, name, true);
      }
    }
  }
}

async function deleteEntry(entry) {
  const label = entry.isDir ? 'folder' : 'file';
  if (!confirm(`Delete ${label} "${entry.name}"? This cannot be undone.`)) return;
  await removeEntry(entry.path, entry.name, false);
}

async function createFolder() {
  const raw = prompt('New folder name:');
  if (raw === null) return;
  const name = raw.trim();
  if (!name) return;
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    toast('Invalid folder name.');
    return;
  }
  const target = joinPath(state.files.path, name);
  try {
    await api('/api/files/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: target }),
    });
    toast(`Created folder "${name}".`, 'success');
    await refreshFiles();
  } catch (_) { /* toast already shown */ }
}

function initFiles() {
  $('#files-up').addEventListener('click', () => {
    if (state.files.path) navigateTo(parentPath(state.files.path));
  });
  $('#files-mkdir').addEventListener('click', createFolder);

  $('#files-breadcrumbs').addEventListener('click', (e) => {
    const crumb = e.target.closest('.crumb');
    if (crumb) navigateTo(decodeURIComponent(crumb.dataset.path));
  });

  $('#files-list').addEventListener('click', (e) => {
    const open = e.target.closest('[data-dir].file-open');
    if (open) {
      navigateTo(decodeURIComponent(open.dataset.dir));
      return;
    }
    const del = e.target.closest('.file-delete');
    if (del) {
      deleteEntry({
        path: decodeURIComponent(del.dataset.path),
        name: del.dataset.name,
        isDir: del.dataset.dir === 'true',
      });
    }
  });
}

/* ------------------------------------------------------------
   Init
   ------------------------------------------------------------ */

function init() {
  initTabs();
  initStatus();
  initPhotos();
  initFiles();

  // Initial data + 30s status polling (silent, so a sleeping server never toasts)
  refreshStatus(false);
  setInterval(() => {
    if (!document.hidden) refreshStatus(true);
  }, 30000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.active === 'status') refreshStatus(true);
  });
}

init();
