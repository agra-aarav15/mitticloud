import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../icons.jsx'
import { toast, humanizeBytes, timeAgo } from '../api.js'
import './HostPanel.css'

// MittiHost — host a static website from this phone, free.
// The toast bus comes from api.js (imported, not modified); upload progress
// is inline text so it stays visible while batches are in flight.

const POLL_MS = 30000
const NAME_RE = /^[a-z0-9-]{1,32}$/
const MAX_FILE_BYTES = 2 * 1024 * 1024 // server refuses files over 2 MB
const BATCH_FILES = 20
const BATCH_BYTES = 16 * 1024 * 1024 // stay under the server's 25 MB/request cap

async function j(res) {
  const d = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(d.error || res.statusText), { status: res.status })
  return d
}

const fetchSites = () => fetch('/api/sites').then(j).then((d) => d.sites || [])

const createSite = (name) =>
  fetch('/api/sites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  }).then(j)

const uploadSiteFiles = (name, files) =>
  fetch('/api/sites/' + encodeURIComponent(name) + '/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files })
  }).then(j)

const deleteSite = (name) =>
  fetch('/api/sites/' + encodeURIComponent(name), { method: 'DELETE' }).then(j)

const siteUrl = (name) => window.location.origin + '/s/' + name

// Read one File as base64 (no prefix) via FileReader.
function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onerror = () => reject(new Error('Could not read ' + file.name))
    r.onload = () => {
      const s = String(r.result)
      resolve(s.slice(s.indexOf(',') + 1))
    }
    r.readAsDataURL(file)
  })
}

// webkitRelativePath minus the top-level folder name ("site/css/a.css" -> "css/a.css").
function relPath(f) {
  const p = String(f.webkitRelativePath || f.name).replace(/\\/g, '/')
  const parts = p.split('/')
  return (parts.length > 1 ? parts.slice(1) : parts).join('/') || f.name
}

export default function HostPanel() {
  const [sites, setSites] = useState(null) // null = loading
  const [name, setName] = useState('')
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState('')
  const [busyName, setBusyName] = useState(null)
  const [confirmName, setConfirmName] = useState(null)
  const mountedRef = useRef(true)
  const confirmTimerRef = useRef(null)

  const load = useCallback(async () => {
    try {
      const list = await fetchSites()
      if (!mountedRef.current) return
      setSites(list)
    } catch {
      if (mountedRef.current) setSites([])
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    load()
    const timer = setInterval(load, POLL_MS)
    return () => {
      mountedRef.current = false
      clearInterval(timer)
      clearTimeout(confirmTimerRef.current)
    }
  }, [load])

  // folder input needs the directory attribute set on the DOM node itself
  const setFolderInput = (el) => {
    if (el) el.webkitdirectory = true
  }

  const pick = async (e) => {
    const picked = Array.from(e.target.files || [])
    e.target.value = '' // allow re-picking the same folder
    const siteName = name.trim()
    if (!siteName) {
      toast('Give the site a name first', 'info')
      return
    }
    if (!NAME_RE.test(siteName)) {
      toast('Name can use lowercase letters, digits and dashes (max 32)', 'err')
      return
    }
    if (picked.length === 0) {
      toast('That folder is empty', 'info')
      return
    }
    const tooBig = picked.find((f) => f.size > MAX_FILE_BYTES)
    if (tooBig) {
      toast(tooBig.name + ' is larger than 2 MB — not uploaded', 'err')
      return
    }

    setUploading(true)
    try {
      setProgress('Creating site ' + siteName + '…')
      try {
        await createSite(siteName)
      } catch (err) {
        if (err.status !== 409) throw err
        toast('Site already exists — updating its files', 'info')
      }

      // batch uploads to stay under the server's per-request cap
      const batches = []
      let cur = []
      let curBytes = 0
      for (const f of picked) {
        if (cur.length > 0 && (cur.length >= BATCH_FILES || curBytes + f.size > BATCH_BYTES)) {
          batches.push(cur)
          cur = []
          curBytes = 0
        }
        cur.push(f)
        curBytes += f.size
      }
      if (cur.length > 0) batches.push(cur)

      let done = 0
      if (mountedRef.current) setProgress('Uploading 0/' + picked.length)
      for (const batch of batches) {
        const files = []
        for (const f of batch) {
          files.push({ path: relPath(f), contentBase64: await readAsBase64(f) })
        }
        await uploadSiteFiles(siteName, files)
        done += batch.length
        if (mountedRef.current) setProgress('Uploading ' + done + '/' + picked.length)
      }

      toast('Site published at /s/' + siteName, 'ok')
      if (mountedRef.current) setName('')
      await load()
    } catch (err) {
      toast(err.message || 'Could not publish the site', 'err')
    } finally {
      if (mountedRef.current) {
        setUploading(false)
        setProgress('')
      }
    }
  }

  const copyUrl = async (site) => {
    const url = siteUrl(site.name)
    try {
      await navigator.clipboard.writeText(url)
      toast('Site URL copied', 'ok')
    } catch {
      toast('Could not copy — ' + url, 'err')
    }
  }

  const askRemove = (site) => {
    clearTimeout(confirmTimerRef.current)
    setConfirmName(site.name)
    confirmTimerRef.current = setTimeout(() => setConfirmName(null), 3500)
  }

  const remove = async (site) => {
    setBusyName(site.name)
    try {
      await deleteSite(site.name)
      if (mountedRef.current) {
        toast('Site deleted', 'ok')
        setConfirmName(null)
      }
      await load()
    } catch (err) {
      toast(err.message || 'Could not delete the site', 'err')
    } finally {
      if (mountedRef.current) setBusyName(null)
    }
  }

  return (
    <div className="hs-panel">
      <div className="hs-toolbar">
        <div>
          <div className="hs-title">MittiHost</div>
          <div className="hs-subtitle muted">Free website hosting from this phone</div>
        </div>
      </div>

      <section className="hs-block">
        <div className="hs-label muted">New site</div>
        <div className="hs-form glass">
          <div className="hs-form-row">
            <input
              className="hs-input"
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              placeholder="my-site"
              aria-label="Site name"
              maxLength={32}
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              disabled={uploading}
            />
            <label className="btn btn-primary hs-pick">
              <Icon name="upload" size={15} />
              {uploading ? 'Uploading…' : 'Upload folder'}
              <input
                ref={setFolderInput}
                type="file"
                className="hs-file"
                onChange={pick}
                multiple
                disabled={uploading}
                aria-label="Choose a folder to host"
              />
            </label>
          </div>
          {uploading && progress ? <div className="hs-progress">{progress}</div> : null}
        </div>
      </section>

      <section className="hs-block">
        <div className="hs-label muted">Your sites</div>
        {sites === null ? (
          <div className="hs-card glass" aria-hidden="true">
            {[0, 1].map((i) => (
              <div key={i} className="hs-sk-row">
                <div className="skeleton hs-sk-line" style={{ width: i === 0 ? 160 : 120 }} />
                <div className="skeleton hs-sk-line" style={{ width: 90 }} />
              </div>
            ))}
          </div>
        ) : sites.length === 0 ? (
          <div className="empty">
            <div className="btn iconbtn" aria-hidden="true">
              <Icon name="cloud" size={22} />
            </div>
            Host a website from this phone, free. Reachable on your LAN or Tailscale; pair with
            Cloudflare Tunnel for a public URL.
          </div>
        ) : (
          sites.map((site) => (
            <section key={site.name} className="hs-card glass">
              <div className="hs-card-head">
                <div className="hs-card-title">
                  <span className="hs-name">{site.name}</span>
                  <span className="chip">
                    {site.fileCount} {site.fileCount === 1 ? 'file' : 'files'}
                  </span>
                  <span className="chip">{humanizeBytes(site.bytes)}</span>
                </div>
                <div className="hs-card-actions">
                  {confirmName === site.name ? (
                    <button
                      className="btn btn-danger hs-sure"
                      onClick={() => remove(site)}
                      disabled={busyName === site.name}
                    >
                      Sure?
                    </button>
                  ) : (
                    <button
                      className="btn iconbtn btn-danger"
                      onClick={() => askRemove(site)}
                      aria-label={'Delete ' + site.name}
                      title="Delete"
                      disabled={busyName === site.name}
                    >
                      <Icon name="trash" size={15} />
                    </button>
                  )}
                </div>
              </div>
              <div className="hs-meta">
                <button
                  type="button"
                  className="hs-url"
                  onClick={() => copyUrl(site)}
                  title="Copy the full site URL"
                >
                  <span className="hs-url-path">{site.url || '/s/' + site.name}</span>
                  <Icon name="upload" size={12} />
                </button>
                <span className="hs-created muted">hosted {timeAgo(site.createdAt)}</span>
              </div>
            </section>
          ))
        )}
      </section>
    </div>
  )
}
