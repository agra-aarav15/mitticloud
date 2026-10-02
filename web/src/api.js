// Shared API client + helpers. Panels import from here — do not duplicate.

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

export const runSandbox = (language, code, confirm = false) =>
  fetch('/api/sandbox/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ language, code, confirm })
  }).then(j)

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
