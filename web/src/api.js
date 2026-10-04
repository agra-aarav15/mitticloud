// Shared API client + helpers. Panels import from here — do not duplicate.

// The lock token (set via Status → Security or the Host panel) rides on every
// write so the owner never gets locked out of his own server. Reads stay open.
const TOKEN_KEY = 'mitti_token'
export function tokenHeaders(extra = {}) {
  let t = ''
  try {
    t = sessionStorage.getItem(TOKEN_KEY) || ''
  } catch {
    /* private mode */
  }
  return t ? { ...extra, 'x-mitti-token': t } : extra
}

async function j(res) {
  const d = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(d.error || res.statusText), { status: res.status })
  return d
}

export const fetchStatus = () => fetch('/api/status').then(j)
export const fetchPhotos = () => fetch('/api/photos').then(j).then((d) => d.photos)

export async function uploadPhotos(files) {
  const fd = new FormData()
  for (const f of files) fd.append('photos', f)
  return fetch('/api/photos/upload', { method: 'POST', body: fd }).then(j)
}

export const deletePhoto = (path) =>
  fetch('/api/photos?path=' + encodeURIComponent(path), { method: 'DELETE' }).then(j)

export const listFiles = (path = '') =>
  fetch('/api/files?path=' + encodeURIComponent(path)).then(j)

export const mkdir = (path) =>
  fetch('/api/files/mkdir', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path })
  }).then(j)

export const deleteFile = (path, force = false) =>
  fetch('/api/files?path=' + encodeURIComponent(path) + (force ? '&force=true' : ''), {
    method: 'DELETE'
  }).then(j)

export const downloadUrl = (path) => '/api/files/download?path=' + encodeURIComponent(path)

// --- Agent Server (24/7 multi-provider agent) ---

export const fetchAgentProviders = () => fetch('/api/agent/providers').then(j)
export const saveAgentKey = (providerId, key) =>
  fetch('/api/agent/keys', {
    method: 'PUT',
    headers: tokenHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ providerId, key })
  }).then(j)
export const fetchAgentWorkspaces = () =>
  fetch('/api/agent/workspaces').then(j).then((d) => d.workspaces || [])
export const fetchAgentSessions = () =>
  fetch('/api/agent/sessions').then(j).then((d) => d.sessions || [])
export const createAgentSession = (payload) =>
  fetch('/api/agent/sessions', {
    method: 'POST',
    headers: tokenHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload)
  }).then(j)
export const fetchAgentSession = (id) =>
  fetch('/api/agent/sessions/' + encodeURIComponent(id)).then(j)
export const sendAgentMessage = (id, text, force = false) =>
  fetch('/api/agent/sessions/' + encodeURIComponent(id) + '/messages', {
    method: 'POST',
    headers: tokenHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ text, force })
  }).then(j)
export const deleteAgentSession = (id) =>
  fetch('/api/agent/sessions/' + encodeURIComponent(id), {
    method: 'DELETE',
    headers: tokenHeaders()
  }).then(j)

// --- MittiHost runtime (LAN test + Cloudflare tunnel + load test) ---

export const fetchHostLan = () => fetch('/api/host/lan').then(j)
export const fetchTunnel = () => fetch('/api/host/tunnel').then(j)
export const startQuickTunnel = (bin) =>
  fetch('/api/host/tunnel/quick', {
    method: 'POST',
    headers: tokenHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ bin })
  }).then(j)
export const startTokenTunnel = (token, bin) =>
  fetch('/api/host/tunnel/token', {
    method: 'POST',
    headers: tokenHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ token, bin })
  }).then(j)
export const stopTunnel = () =>
  fetch('/api/host/tunnel/stop', { method: 'POST', headers: tokenHeaders() }).then(j)
export const runLoadTest = (payload) =>
  fetch('/api/host/loadtest', {
    method: 'POST',
    headers: tokenHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload)
  }).then(j)

// --- Cloudflare Pages (publish a site to the user's own domain) ---

export const fetchCfStatus = () => fetch('/api/host/cf/status').then(j)
export const saveCfToken = (token) =>
  fetch('/api/host/cf/token', {
    method: 'PUT',
    headers: tokenHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ token })
  }).then(j)
export const clearCfToken = () =>
  fetch('/api/host/cf/token', { method: 'DELETE', headers: tokenHeaders() }).then(j)
export const publishCfSite = (site, accountId) =>
  fetch('/api/host/cf/publish', {
    method: 'POST',
    headers: tokenHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ site, accountId })
  }).then(j)

// --- Tasks (little jobs) ---

export const fetchTasks = () => fetch('/api/tasks').then(j).then((d) => d.tasks || [])

export const createTask = (payload) =>
  fetch('/api/tasks', {
    method: 'POST',
    headers: tokenHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload)
  }).then(j)

export const updateTask = (id, patch) =>
  fetch('/api/tasks/' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: tokenHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(patch)
  }).then(j)

export const deleteTask = (id) =>
  fetch('/api/tasks/' + encodeURIComponent(id), { method: 'DELETE', headers: tokenHeaders() }).then(j)

export const runTask = (id, force = false) =>
  fetch('/api/tasks/' + encodeURIComponent(id) + '/run', {
    method: 'POST',
    headers: tokenHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ force })
  }).then(j)

export const fetchTaskRuns = (id) =>
  fetch('/api/tasks/' + encodeURIComponent(id) + '/runs').then(j).then((d) => d.runs || [])

export const webhookPath = (webhookId) => '/hook/' + webhookId
export const webhookUrl = (webhookId) => window.location.origin + webhookPath(webhookId)

export function humanizeBytes(n) {
  if (n == null) return '—'
  if (n < 1024) return n + ' B'
  const u = ['KB', 'MB', 'GB', 'TB']
  let i = -1
  do {
    n /= 1024
    i++
  } while (n >= 1024 && i < u.length - 1)
  return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i]
}

export function humanizeUptime(s) {
  if (s == null) return '—'
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d) return d + 'd ' + h + 'h'
  if (h) return h + 'h ' + m + 'm'
  return m + 'm ' + Math.floor(s % 60) + 's'
}

export function timeAgo(iso) {
  if (!iso) return 'never'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return 'never'
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000))
  if (s < 45) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm ago'
  const h = Math.floor(m / 60)
  if (h < 24) return h + 'h ago'
  const d = Math.floor(h / 24)
  return d + 'd ago'
}

// Tiny toast bus — App hosts the renderer, panels call toast().
let toastId = 0
const listeners = new Set()
export function onToast(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
export function toast(msg, type = 'info') {
  listeners.forEach((f) => f({ id: ++toastId, msg, type }))
}
