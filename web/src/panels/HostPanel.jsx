import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../icons.jsx'
import { toast, humanizeBytes, timeAgo, copyText } from '../api.js'
import GoLive from './GoLive.jsx'
import './HostPanel.css'

// MittiHost — host a static website from this phone, free.
// The toast bus comes from api.js (imported, not modified); upload progress
// is inline text so it stays visible while batches are in flight.

const POLL_MS = 30000
const NAME_RE = /^[a-z0-9-]{1,32}$/
const MAX_FILE_BYTES = 2 * 1024 * 1024 // server refuses files over 2 MB
const BATCH_FILES = 20
const BATCH_BYTES = 16 * 1024 * 1024 // stay under the server's 25 MB/request cap

// --- local fetch helpers (api.js is shared; writes here attach the lock token) ---
const TOKEN_KEY = 'mitti_token'
const getToken = () => {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || ''
  } catch {
    return ''
  }
}
const storeToken = (t) => {
  try {
    if (t) sessionStorage.setItem(TOKEN_KEY, t)
    else sessionStorage.removeItem(TOKEN_KEY)
  } catch {
    /* ignore */
  }
}

async function j(res) {
  const d = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(d.error || res.statusText), { status: res.status })
  return d
}

// Wraps fetch for writes: attaches the lock token, and on 401 clears it so the
// inline token bar re-asks on the next render.
const authedFetch = (url, opts = {}) =>
  fetch(url, {
    ...opts,
    headers: { 'x-mitti-token': getToken(), ...(opts.headers || {}) }
  }).then((res) => {
    if (res.status === 401) {
      storeToken('')
      throw Object.assign(new Error('Locked — enter your access token'), { status: 401 })
    }
    return res
  })

const fetchSites = () => fetch('/api/sites').then(j).then((d) => d.sites || [])

const createSite = (name) =>
  authedFetch('/api/sites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  }).then(j)

const uploadSiteFiles = (name, files) =>
  authedFetch('/api/sites/' + encodeURIComponent(name) + '/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files })
  }).then(j)

const uploadSiteZip = (name, file) => {
  const fd = new FormData()
  fd.append('zip', file)
  return authedFetch('/api/sites/' + encodeURIComponent(name) + '/zip', {
    method: 'POST',
    body: fd
  }).then(j)
}

const siteUsageReq = (name) =>
  fetch('/api/sites/' + encodeURIComponent(name) + '/usage').then(j)

const deleteSite = (name) =>
  authedFetch('/api/sites/' + encodeURIComponent(name), { method: 'DELETE' }).then(j)

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
  const [zipBusy, setZipBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [busyName, setBusyName] = useState(null)
  const [confirmName, setConfirmName] = useState(null)
  const [usageByName, setUsageByName] = useState({})
  const [needToken, setNeedToken] = useState(false)
  const [tokenDraft, setTokenDraft] = useState('')
  const mountedRef = useRef(true)
  const confirmTimerRef = useRef(null)

  const load = useCallback(async (withUsage = true) => {
    let list = []
    try {
      list = await fetchSites()
    } catch {
      list = []
    }
    if (!mountedRef.current) return
    setSites(list)
    if (withUsage && list.length > 0) {
      const found = await Promise.all(
        list.map(async (s) => {
          try {
            const u = await siteUsageReq(s.name)
            return u ? [s.name, u] : null
          } catch {
            return null // endpoint may not exist yet — chips fall back to list data
          }
        })
      )
      if (!mountedRef.current) return
      const map = {}
      for (const f of found) if (f) map[f[0]] = f[1]
      setUsageByName(map)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    load()
    // If the vault is locked and we hold no token, surface the inline token bar
    // before the first write fails. The endpoint may not exist yet — stay silent.
    ;(async () => {
      try {
        const d = await fetch('/api/lock-status').then(j)
        if (mountedRef.current && d && d.locked && !getToken()) setNeedToken(true)
      } catch {
        /* not ready yet */
      }
    })()
    const timer = setInterval(() => load(false), POLL_MS)
    return () => {
      mountedRef.current = false
      clearInterval(timer)
      clearTimeout(confirmTimerRef.current)
    }
  }, [load])

  const saveToken = (e) => {
    e.preventDefault()
    const t = tokenDraft.trim()
    if (!t) return
    storeToken(t)
    setTokenDraft('')
    setNeedToken(false)
    toast('Token saved', 'ok')
  }

  // folder input needs the directory attribute set on the DOM node itself
  const setFolderInput = (el) => {
    if (el) el.webkitdirectory = true
  }

  const validName = () => {
    const siteName = name.trim()
    if (!siteName) {
      toast('Give the site a name first', 'info')
      return null
    }
    if (!NAME_RE.test(siteName)) {
      toast('Name can use lowercase letters, digits and dashes (max 32)', 'err')
      return null
    }
    return siteName
  }

  const ensureSite = async (siteName) => {
    try {
      await createSite(siteName)
    } catch (err) {
      if (err.status !== 409) throw err
      toast('Site already exists — updating its files', 'info')
    }
  }

  const pick = async (e) => {
    const picked = Array.from(e.target.files || [])
    e.target.value = '' // allow re-picking the same folder
    const siteName = validName()
    if (!siteName) return
    if (picked.length === 0) {
      toast('That folder is empty', 'info')
      return
    }
// one oversized file skips itself instead of sinking the whole publish
    const tooBig = picked.filter((f) => f.size > MAX_FILE_BYTES)
    const usable = picked.filter((f) => f.size <= MAX_FILE_BYTES)
    if (usable.length === 0) {
      toast('Every file was larger than 2 MB — nothing to upload', 'err')
      return
    }

    setUploading(true)
    try {
      setProgress('Creating site ' + siteName + '...')
      await ensureSite(siteName)

      // batch uploads to stay under the server's per-request cap
      const batches = []
      let cur = []
      let curBytes = 0
      for (const f of usable) {
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
      if (mountedRef.current) setProgress('Uploading 0/' + usable.length)
      for (const batch of batches) {
        const files = []
        for (const f of batch) {
          files.push({ path: relPath(f), contentBase64: await readAsBase64(f) })
        }
        await uploadSiteFiles(siteName, files)
        done += batch.length
        if (mountedRef.current) setProgress('Uploading ' + done + '/' + usable.length)
      }

      toast(
        'Site published at /s/' +
          siteName +
          (tooBig.length ? ' · skipped ' + tooBig.length + ' over 2 MB' : ''),
        'ok'
      )
      if (mountedRef.current) setName('')
      await load(true)
    } catch (err) {
      if (err && err.status === 401 && mountedRef.current) setNeedToken(true)
      toast(err.message || 'Could not publish the site', 'err')
    } finally {
      if (mountedRef.current) {
        setUploading(false)
        setProgress('')
      }
    }
  }

  const pickZip = async (e) => {
    const file = (e.target.files || [])[0]
    e.target.value = '' // allow re-picking the same zip
    const siteName = validName()
    if (!siteName || !file) return
    setZipBusy(true)
    try {
      setProgress('Creating site ' + siteName + '…')
      await ensureSite(siteName)
      if (mountedRef.current) setProgress('Uploading zip…')
      const r = await uploadSiteZip(siteName, file)
      const n = r && typeof r.files === 'number' ? r.files : null
      toast(n != null ? 'Published ' + n + ' files at /s/' + siteName : 'Site published at /s/' + siteName, 'ok')
      if (mountedRef.current) setName('')
      await load(true)
    } catch (err) {
      if (err && err.status === 401 && mountedRef.current) setNeedToken(true)
      toast(err.message || 'Could not publish the zip', 'err')
    } finally {
      if (mountedRef.current) {
        setZipBusy(false)
        setProgress('')
      }
    }
  }

  const copyUrl = async (site) => {
    const url = siteUrl(site.name)
    const ok = await copyText(url)
    toast(ok ? 'Site URL copied' : "Couldn't copy — the URL is " + url, ok ? 'ok' : 'info')
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
      await load(true)
    } catch (err) {
      if (err && err.status === 401 && mountedRef.current) setNeedToken(true)
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

      {needToken && (
        <form className="banner" onSubmit={saveToken}>
          <Icon name="lock" size={15} />
          <span className="hs-token-label">Vault is locked — enter your access token to make changes.</span>
          <input
            className="hs-token-input"
            type="password"
            value={tokenDraft}
            onChange={(e) => setTokenDraft(e.target.value)}
            placeholder="access token"
            aria-label="Access token"
            autoFocus
          />
          <button type="submit" className="btn btn-primary hs-token-btn" disabled={!tokenDraft.trim()}>
            Save
          </button>
        </form>
      )}

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
              disabled={uploading || zipBusy}
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
                disabled={uploading || zipBusy}
                aria-label="Choose a folder to host"
              />
            </label>
            <label className="btn hs-pick">
              <Icon name="file" size={15} />
              {zipBusy ? 'Publishing…' : 'Upload ZIP'}
              <input
                type="file"
                className="hs-file"
                accept=".zip,application/zip,application/x-zip-compressed"
                onChange={pickZip}
                disabled={uploading || zipBusy}
                aria-label="Choose a ZIP file to host"
              />
            </label>
          </div>
          {(uploading || zipBusy) && progress ? <div className="hs-progress">{progress}</div> : null}
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
          sites.map((site) => {
            const u = usageByName[site.name]
            const files = u && typeof u.files === 'number' ? u.files : site.fileCount
            const bytes = u && typeof u.bytes === 'number' ? u.bytes : site.bytes
            return (
              <section key={site.name} className="hs-card glass">
                <div className="hs-card-head">
                  <div className="hs-card-title">
                    <span className="hs-name">{site.name}</span>
                    <span className="chip">
                      {files} {files === 1 ? 'file' : 'files'}
                    </span>
                    <span className="chip">{humanizeBytes(bytes)}</span>
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
            )
          })
        )}
      </section>

      <GoLive sites={sites === null ? [] : sites} />
    </div>
  )
}
