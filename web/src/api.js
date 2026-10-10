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

export const listFiles = (path = '') =>
  fetch('/api/files?path=' + encodeURIComponent(path)).then(j)

export const downloadUrl = (path) => '/api/files/download?path=' + encodeURIComponent(path)

export const fetchBridgeSessions = () =>
  fetch('/api/bridge/sessions').then(j).then((d) => d.sessions || [])

// Copy that tells the truth: the dashboard is usually opened over http://LAN
// where navigator.clipboard does not exist — fall back to execCommand and
// report what actually happened.
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    /* no clipboard API (insecure context) — try the old way */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}


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

// laptop pairing for project memory (the mitti-bridge one-liner)
export const fetchBridgePairing = () => fetch('/api/bridge/pairing').then(j)

// --- deep health + backups ---

export const fetchDeepHealth = () => fetch('/api/health?deep=1').then(j)
export const runBackupNow = () =>
  fetch('/api/backup/run', { method: 'POST', headers: tokenHeaders() }).then(j)

// --- Live apps (real Node.js backends, hosted on this device) ---

export const fetchApps = () => fetch('/api/apps').then(j).then((d) => d.apps || [])
export const createApp = (name) =>
  fetch('/api/apps', {
    method: 'POST',
    headers: tokenHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ name })
  }).then(j)
export const uploadAppFiles = (name, files) =>
  fetch('/api/apps/' + encodeURIComponent(name) + '/files', {
    method: 'POST',
    headers: tokenHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ files })
  }).then(j)
export const uploadAppZip = (name, file) => {
  const fd = new FormData()
  fd.append('zip', file)
  return fetch('/api/apps/' + encodeURIComponent(name) + '/zip', {
    method: 'POST',
    headers: tokenHeaders(),
    body: fd
  }).then(j)
}
export const deployApp = (name, install = true) =>
  fetch('/api/apps/' + encodeURIComponent(name) + '/deploy', {
    method: 'POST',
    headers: tokenHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ install })
  }).then(j)
export const appAction = (name, action, extra = {}) =>
  fetch(`/api/apps/${encodeURIComponent(name)}/${action}`, {
    method: 'POST',
    headers: tokenHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(extra)
  }).then(j)
export const fetchAppLogs = (name) =>
  fetch('/api/apps/' + encodeURIComponent(name) + '/logs').then(j)
export const updateAppConfig = (name, patch) =>
  fetch('/api/apps/' + encodeURIComponent(name), {
    method: 'PATCH',
    headers: tokenHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(patch)
  }).then(j)
export const deleteAppReq = (name) =>
  fetch('/api/apps/' + encodeURIComponent(name), { method: 'DELETE', headers: tokenHeaders() }).then(j)
export const exportApp = async (name) => {
  const res = await fetch('/api/apps/' + encodeURIComponent(name) + '/export', {
    method: 'POST',
    headers: tokenHeaders()
  })
  if (!res.ok) throw Object.assign(new Error('Export failed'), { status: res.status })
  const blob = await res.blob()
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name + '-export.zip'
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 4000)
  return true
}

// --- code editor (one text file, anywhere in the vault) ---

export const fetchFileContent = (path) =>
  fetch('/api/files/content?path=' + encodeURIComponent(path)).then(j)
export const saveFileContent = (path, content) =>
  fetch('/api/files/content', {
    method: 'PUT',
    headers: tokenHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ path, content })
  }).then(j)

// Share that tells the truth: the real share sheet on a phone, copy on
// desktop. Returns 'shared' | 'copied' | 'failed' — never pretends.
export async function shareOrCopy(url, title = '') {
  if (navigator.share) {
    try {
      await navigator.share({ title, url })
      return 'shared'
    } catch (err) {
      if (err && err.name === 'AbortError') return 'shared' // user closed the sheet — done
      /* fall through to copy */
    }
  }
  return (await copyText(url)) ? 'copied' : 'failed'
}

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

// --- client keys (per-app tokens for MCP + the /mcp endpoint) ---

export const fetchClientKeys = () =>
  fetch('/api/clients/keys').then(j).then((d) => d.keys || [])
export const createClientKey = (name) =>
  fetch('/api/clients/keys', {
    method: 'POST',
    headers: tokenHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ name })
  }).then(j)
export const revokeClientKey = (id) =>
  fetch('/api/clients/keys/' + encodeURIComponent(id), {
    method: 'DELETE',
    headers: tokenHeaders()
  }).then(j)

// --- Remote → SSH: the door ZCode's "Remote connection → SSH" method uses ---

export const fetchRemoteSsh = () => fetch('/api/remote/ssh').then(j)
export const enableRemoteSsh = (lan = false) =>
  fetch('/api/remote/ssh/enable', {
    method: 'POST',
    headers: tokenHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ lan })
  }).then(j)
export const disableRemoteSsh = () =>
  fetch('/api/remote/ssh/disable', { method: 'POST', headers: tokenHeaders({ 'Content-Type': 'application/json' }), body: '{}' }).then(j)
