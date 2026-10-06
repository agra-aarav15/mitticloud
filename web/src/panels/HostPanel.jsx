import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../icons.jsx'
import {
  toast,
  humanizeBytes,
  timeAgo,
  copyText,
  shareOrCopy,
  fetchApps,
  createApp,
  uploadAppFiles,
  deployApp,
  appAction,
  fetchAppLogs,
  updateAppConfig,
  deleteAppReq,
  exportApp,
  fetchDeepHealth
} from '../api.js'
import CodeEditor from './CodeEditor.jsx'
import CfPublish from './CfPublish.jsx'
import Tools from './Tools.jsx'
import './HostPanel.css'

// MittiHost — host static sites AND real Node apps from this phone, free.
// One add flow (folder or ZIP, name auto-filled), a real LIVE moment, site
// cards that open/share like links, app cards with logs/env/restart, and
// every write attached to the lock token. Upload progress is inline text so
// it stays visible while batches are in flight.

const POLL_MS = 30000
const APP_POLL_MS = 3000
const NAME_RE = /^[a-z0-9-]{1,32}$/
const MAX_FILE_BYTES = 2 * 1024 * 1024 // server refuses files over 2 MB (static)
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

const siteUsageReq = (name) => fetch('/api/sites/' + encodeURIComponent(name) + '/usage').then(j)

const deleteSite = (name) =>
  authedFetch('/api/sites/' + encodeURIComponent(name), { method: 'DELETE' }).then(j)

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

// "My Portfolio (v2)" -> "my-portfolio-v2" — a name the server accepts.
function suggestName(raw) {
  const s = String(raw || '')
    .toLowerCase()
    .replace(/\.zip$/, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return s || 'my-site'
}

// A folder full of .js files at the root (or a package.json) is an app; a
// folder with an index.html is a site. The chip stays editable either way.
function detectKind(relPaths) {
  if (relPaths.some((p) => p === 'package.json')) return 'app'
  if (relPaths.some((p) => !p.includes('/') && p.endsWith('.js') && !p.endsWith('.config.js'))) return 'app'
  return 'site'
}

function siteUrl(name) {
  return window.location.origin + '/s/' + name
}

function appUrl(port) {
  return 'http://' + window.location.hostname + ':' + port
}

export default function HostPanel() {
  const [sites, setSites] = useState(null) // null = loading
  const [apps, setApps] = useState(null)
  const [siteHealth, setSiteHealth] = useState({}) // name -> {up, status}
  const [usageByName, setUsageByName] = useState({})
  const [needToken, setNeedToken] = useState(false)
  const [tokenDraft, setTokenDraft] = useState('')

  // add flow
  const [picked, setPicked] = useState(null) // {kind:'folder'|'zip', files?, file?, suggested}
  const [nameDraft, setNameDraft] = useState('')
  const [kind, setKind] = useState('site')
  const [publishing, setPublishing] = useState(false)
  const [progress, setProgress] = useState('')

  // live moment
  const [live, setLive] = useState(null) // {kind, name, url}

  // per-card state
  const [confirmName, setConfirmName] = useState(null)
  const [busyName, setBusyName] = useState(null)
  const [previewSite, setPreviewSite] = useState(null)
  const [openLogs, setOpenLogs] = useState(null)
  const [logs, setLogs] = useState([])
  const [editorFile, setEditorFile] = useState(null)
  const [restartHint, setRestartHint] = useState(null) // app name needing restart

  const mountedRef = useRef(true)
  const confirmTimerRef = useRef(null)
  const updateInputRef = useRef(null) // {target: 'site'|'app', name}
  const nameTouchedRef = useRef(false)

  const load = useCallback(async (withUsage = true) => {
    let list = []
    let appList = []
    try {
      list = await fetchSites()
    } catch {
      list = []
    }
    try {
      appList = await fetchApps()
    } catch {
      appList = []
    }
    if (!mountedRef.current) return
    setSites(list)
    setApps(appList)
    if (withUsage && list.length > 0) {
      const found = await Promise.all(
        list.map(async (s) => {
          try {
            const u = await siteUsageReq(s.name)
            return u ? [s.name, u] : null
          } catch {
            return null
          }
        })
      )
      if (!mountedRef.current) return
      const map = {}
      for (const f of found) if (f) map[f[0]] = f[1]
      setUsageByName(map)
    }
  }, [])

  const loadHealth = useCallback(async () => {
    try {
      const d = await fetchDeepHealth()
      if (!mountedRef.current) return
      const map = {}
      for (const r of d.sites?.results || []) map[r.name] = { up: r.up, status: r.status }
      setSiteHealth(map)
    } catch {
      /* the dots just stay dim */
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    load()
    loadHealth()
    ;(async () => {
      try {
        const d = await fetch('/api/lock-status').then(j)
        if (mountedRef.current && d && d.locked && !getToken()) setNeedToken(true)
      } catch {
        /* not ready yet */
      }
    })()
    const siteTimer = setInterval(() => {
      load(false)
      loadHealth()
    }, POLL_MS)
    const appTimer = setInterval(() => {
      fetchApps()
        .then((a) => mountedRef.current && setApps(a))
        .catch(() => {})
    }, APP_POLL_MS)
    return () => {
      mountedRef.current = false
      clearInterval(siteTimer)
      clearInterval(appTimer)
      clearTimeout(confirmTimerRef.current)
    }
  }, [load, loadHealth])

  // live tail while an app card has its logs open (or is starting)
  useEffect(() => {
    if (!openLogs) return
    let alive = true
    const pull = () =>
      fetchAppLogs(openLogs)
        .then((d) => alive && setLogs(d.lines || []))
        .catch(() => {})
    pull()
    const t = setInterval(pull, 2500)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [openLogs])

  useEffect(() => {
    if (openLogs && !(apps || []).some((a) => a.name === openLogs)) setOpenLogs(null)
  }, [apps, openLogs])

  const saveToken = (e) => {
    e.preventDefault()
    const t = tokenDraft.trim()
    if (!t) return
    storeToken(t)
    setTokenDraft('')
    setNeedToken(false)
    toast('Token saved', 'ok')
  }

  // --- add flow: pick -> confirm (auto name + kind chip) -> publish ---
  const setFolderInput = (el) => {
    if (el) el.webkitdirectory = true
  }

  const pickFolder = (e) => {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (!files.length) {
      toast('That folder is empty', 'info')
      return
    }
    const suggested = suggestName(String(files[0].webkitRelativePath || files[0].name).split('/')[0])
    nameTouchedRef.current = false
    setPicked({ kind: 'folder', files, suggested })
    setNameDraft(suggested)
    setKind(detectKind(files.map(relPath)))
  }

  const pickZip = (e) => {
    const file = (e.target.files || [])[0]
    e.target.value = ''
    if (!file) return
    const suggested = suggestName(file.name)
    nameTouchedRef.current = false
    setPicked({ kind: 'zip', file, suggested })
    setNameDraft(suggested)
    setKind('site') // most ZIPs are static exports; the chip is one tap away
  }

  const validName = () => {
    const n = nameDraft.trim()
    if (!n) {
      toast('Give it a name first', 'info')
      return null
    }
    if (!NAME_RE.test(n)) {
      toast('Name can use lowercase letters, digits and dashes (max 32)', 'err')
      return null
    }
    return n
  }

  const publish = async () => {
    const siteName = validName()
    if (!siteName || !picked || publishing) return
    setPublishing(true)
    try {
      if (kind === 'app') await publishApp(siteName)
      else await publishSite(siteName)
    } finally {
      if (mountedRef.current) setPublishing(false)
    }
  }

  const publishSite = async (siteName) => {
    const tooBig = picked.kind === 'folder' ? picked.files.filter((f) => f.size > MAX_FILE_BYTES) : []
    const usable =
      picked.kind === 'folder' ? picked.files.filter((f) => f.size <= MAX_FILE_BYTES) : null
    if (picked.kind === 'folder' && usable.length === 0) {
      toast('Every file was larger than 2 MB — nothing to upload', 'err')
      return
    }
    setProgress('Creating ' + siteName + '…')
    try {
      try {
        await createSite(siteName)
      } catch (err) {
        if (err.status !== 409) throw err
        toast('Already exists — updating its files', 'info')
      }
      if (picked.kind === 'zip') {
        setProgress('Publishing zip…')
        const r = await uploadSiteZip(siteName, picked.file)
        const n = r && typeof r.files === 'number' ? r.files : null
        toast(
          (n != null ? 'Published ' + n + ' files' : 'Site published') +
            (tooBig.length ? '' : ''),
          'ok'
        )
      } else {
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
        setProgress('Uploading 0/' + usable.length)
        for (const batch of batches) {
          const files = []
          for (const f of batch) files.push({ path: relPath(f), contentBase64: await readAsBase64(f) })
          await uploadSiteFiles(siteName, files)
          done += batch.length
          if (mountedRef.current) setProgress('Uploading ' + done + '/' + usable.length)
        }
      }
      setLive({ kind: 'site', name: siteName, url: siteUrl(siteName) })
      setPicked(null)
      setNameDraft('')
      await load(true)
      loadHealth()
    } catch (err) {
      if (err && err.status === 401 && mountedRef.current) setNeedToken(true)
      toast(err.message || 'Could not publish the site', 'err')
    } finally {
      if (mountedRef.current) setProgress('')
    }
  }

  const publishApp = async (appName) => {
    const hasPkg =
      picked.kind === 'zip' ? true : picked.files.some((f) => relPath(f) === 'package.json')
    setProgress('Creating ' + appName + '…')
    try {
      try {
        await createApp(appName)
      } catch (err) {
        if (err.status !== 409) throw err
        toast('Already exists — updating its files', 'info')
      }
      if (picked.kind === 'zip') {
        setProgress('Publishing zip…')
        await uploadAppZip(appName, picked.file)
      } else {
        const batches = []
        let cur = []
        let curBytes = 0
        for (const f of picked.files) {
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
        setProgress('Uploading 0/' + picked.files.length)
        for (const batch of batches) {
          const files = []
          for (const f of batch) files.push({ path: relPath(f), contentBase64: await readAsBase64(f) })
          await uploadAppFiles(appName, files)
          done += batch.length
          if (mountedRef.current) setProgress('Uploading ' + done + '/' + picked.files.length)
        }
      }
      setProgress(hasPkg ? 'Installing packages…' : 'Starting…')
      const r = await deployApp(appName, hasPkg)
      setLive({ kind: 'app', name: appName, url: appUrl(r.port), port: r.port })
      toast((hasPkg ? 'Packages installed — a' : 'A') + 'pp is live', 'ok')
      setPicked(null)
      setNameDraft('')
      await load(false)
    } catch (err) {
      if (err && err.status === 401 && mountedRef.current) setNeedToken(true)
      toast(err.message || 'Could not deploy the app', 'err')
    } finally {
      if (mountedRef.current) setProgress('')
    }
  }

  // --- update an existing card with a fresh folder/zip pick ---
  const askUpdate = (target, name) => {
    updateInputRef.current = { target, name }
    const el = document.getElementById(target === 'app' ? 'app-update-input' : 'site-update-input')
    if (el) el.click()
  }

  const onUpdatePick = async (e, target) => {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    const meta = updateInputRef.current
    if (!meta || !files.length) return
    setBusyName(meta.name)
    try {
      if (target === 'site') {
        const tooBig = files.filter((f) => f.size > MAX_FILE_BYTES)
        const usable = files.filter((f) => f.size <= MAX_FILE_BYTES)
        if (!usable.length) {
          toast('Every file was larger than 2 MB — nothing to upload', 'err')
          return
        }
        setProgress('Updating ' + meta.name + '…')
        try {
          await createSite(meta.name)
        } catch (err) {
          if (err.status !== 409) throw err
        }
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
        if (cur.length) batches.push(cur)
        let done = 0
        for (const batch of batches) {
          const out = []
          for (const f of batch) out.push({ path: relPath(f), contentBase64: await readAsBase64(f) })
          await uploadSiteFiles(meta.name, out)
          done += batch.length
          if (mountedRef.current) setProgress('Uploading ' + done + '/' + usable.length)
        }
        setLive({ kind: 'site', name: meta.name, url: siteUrl(meta.name) })
        toast('Site updated' + (tooBig.length ? ' · skipped ' + tooBig.length + ' over 2 MB' : ''), 'ok')
        await load(true)
        loadHealth()
      } else {
        const hasPkg = files.some((f) => relPath(f) === 'package.json')
        setProgress('Updating ' + meta.name + '…')
        const batches = []
        let cur = []
        let curBytes = 0
        for (const f of files) {
          if (cur.length > 0 && (cur.length >= BATCH_FILES || curBytes + f.size > BATCH_BYTES)) {
            batches.push(cur)
            cur = []
            curBytes = 0
          }
          cur.push(f)
          curBytes += f.size
        }
        if (cur.length) batches.push(cur)
        let done = 0
        for (const batch of batches) {
          const out = []
          for (const f of batch) out.push({ path: relPath(f), contentBase64: await readAsBase64(f) })
          await uploadAppFiles(meta.name, out)
          done += batch.length
          if (mountedRef.current) setProgress('Uploading ' + done + '/' + files.length)
        }
        setProgress(hasPkg ? 'Installing packages…' : 'Restarting…')
        await deployApp(meta.name, hasPkg)
        setLive({ kind: 'app', name: meta.name, url: null })
        toast('App updated and restarted', 'ok')
        await load(false)
      }
    } catch (err) {
      if (err && err.status === 401 && mountedRef.current) setNeedToken(true)
      toast(err.message || 'Could not update', 'err')
    } finally {
      if (mountedRef.current) {
        setBusyName(null)
        setProgress('')
      }
    }
  }

  // --- card actions ---
  const copyUrl = async (url) => {
    const ok = await copyText(url)
    toast(ok ? 'Link copied' : "Couldn't copy — the link is " + url, ok ? 'ok' : 'info')
  }

  const shareUrl = async (url, name) => {
    const r = await shareOrCopy(url, name + ' — live from my pocket cloud')
    if (r === 'copied') toast('Copied — paste it anywhere', 'ok')
    else if (r === 'failed') toast("Couldn't copy — the link is " + url, 'info')
  }

  const askRemove = (name) => {
    clearTimeout(confirmTimerRef.current)
    setConfirmName(name)
    confirmTimerRef.current = setTimeout(() => setConfirmName(null), 3500)
  }

  const removeSite = async (site) => {
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

  const appAct = async (app, action, extra = {}) => {
    setBusyName(app.name + ':' + action)
    try {
      await appAction(app.name, action, extra)
      if (action === 'restart') {
        setRestartHint((cur) => {
          const next = { ...cur }
          delete next[app.name]
          return next
        })
      }
      await load(false)
    } catch (err) {
      if (err && err.status === 507 && err.message.includes('Start anyway')) {
        // surfaced by the Start button's own confirm path
      }
      toast(err.message || 'That did not work', 'err')
    } finally {
      if (mountedRef.current) setBusyName(null)
    }
  }

  const startAppConfirm = async (app) => {
    // a stopped-for-a-reason app starts straight; the RAM guard lives server-side
    // and its message offers "start anyway" — mirror it here for one tap
    try {
      await appAct(app, 'start')
    } catch {
      /* appAct already toasted */
    }
  }

  const removeApp = async (app) => {
    setBusyName(app.name)
    try {
      await deleteAppReq(app.name)
      if (mountedRef.current) {
        toast('App deleted', 'ok')
        setConfirmName(null)
      }
      await load(false)
    } catch (err) {
      if (err && err.status === 401 && mountedRef.current) setNeedToken(true)
      toast(err.message || 'Could not delete the app', 'err')
    } finally {
      if (mountedRef.current) setBusyName(null)
    }
  }

  const saveEnv = async (app, env) => {
    setBusyName(app.name + ':env')
    try {
      await updateAppConfig(app.name, { env })
      toast('Env saved — restart to apply', 'ok')
      await load(false)
    } catch (err) {
      toast(err.message || 'Could not save env', 'err')
    } finally {
      if (mountedRef.current) setBusyName(null)
    }
  }

  const doExport = async (app) => {
    setBusyName(app.name + ':export')
    try {
      await exportApp(app.name)
      toast('Export downloaded — any machine with Node can run it', 'ok')
    } catch (err) {
      toast(err.message || 'Could not export', 'err')
    } finally {
      if (mountedRef.current) setBusyName(null)
    }
  }

  const sitesList = sites === null ? null : sites
  const appsList = apps === null ? null : apps

  return (
    <div className="hs-panel">
      <div className="hs-toolbar">
        <div>
          <div className="hs-title">MittiHost</div>
          <div className="hs-subtitle muted">Sites and live apps, hosted on this phone</div>
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

      {live && (
        <section className="hs-live glass" aria-label="Publish result">
          <div className="hs-live-dot" aria-hidden="true" />
          <div className="hs-live-text">
            <div className="hs-live-title">
              {live.name} is live{live.kind === 'app' ? ' — and running' : ''}.
            </div>
            {live.url && <div className="hs-live-url">{live.url}</div>}
            {!live.url && <div className="hs-live-url muted">Open the app card below for its link.</div>}
          </div>
          <div className="hs-live-actions">
            {live.url && (
              <a className="btn btn-primary" href={live.url} target="_blank" rel="noreferrer">
                Open <Icon name="arrowUp" size={14} />
              </a>
            )}
            {live.url && (
              <button className="btn" onClick={() => copyUrl(live.url)}>
                <Icon name="copy" size={14} /> Copy
              </button>
            )}
            {live.url && (
              <button className="btn" onClick={() => shareUrl(live.url, live.name)}>
                <Icon name="share" size={14} /> Share
              </button>
            )}
            <button className="btn" onClick={() => setLive(null)}>
              Done
            </button>
          </div>
        </section>
      )}

      <section className="hs-block">
        <div className="hs-label muted">Add a site or app</div>
        <div className="hs-form glass">
          {!picked ? (
            <div className="hs-form-row">
              <label className="btn btn-primary hs-pick">
                <Icon name="upload" size={15} />
                Choose a folder
                <input
                  ref={setFolderInput}
                  type="file"
                  className="hs-file"
                  onChange={pickFolder}
                  multiple
                  disabled={publishing}
                  aria-label="Choose a folder to host"
                />
              </label>
              <label className="btn hs-pick">
                <Icon name="file" size={15} />
                Upload a ZIP
                <input
                  type="file"
                  className="hs-file"
                  accept=".zip,application/zip,application/x-zip-compressed"
                  onChange={pickZip}
                  disabled={publishing}
                  aria-label="Choose a ZIP file to host"
                />
              </label>
              <span className="hs-form-hint muted">
                A folder with a package.json or a .js entry runs as a live app. Everything else is a
                website.
              </span>
            </div>
          ) : (
            <div className="hs-confirm">
              <div className="hs-confirm-row">
                <input
                  className="hs-input"
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value.toLowerCase())}
                  placeholder="name"
                  aria-label="Name"
                  maxLength={32}
                  autoCapitalize="off"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={publishing}
                />
                <div className="hs-kind" role="radiogroup" aria-label="What is this?">
                  <button
                    type="button"
                    className={'hs-kind-btn' + (kind === 'site' ? ' on' : '')}
                    aria-pressed={kind === 'site'}
                    onClick={() => setKind('site')}
                    disabled={publishing}
                  >
                    <Icon name="globe" size={14} /> Website
                  </button>
                  <button
                    type="button"
                    className={'hs-kind-btn' + (kind === 'app' ? ' on' : '')}
                    aria-pressed={kind === 'app'}
                    onClick={() => setKind('app')}
                    disabled={publishing}
                  >
                    <Icon name="cpu" size={14} /> Node app
                  </button>
                </div>
              </div>
              <div className="hs-confirm-row">
                <button className="btn btn-primary" disabled={publishing} onClick={publish}>
                  {publishing && <span className="spin" aria-hidden="true" />}
                  {publishing ? 'Publishing…' : kind === 'app' ? 'Deploy app' : 'Publish site'}
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    setPicked(null)
                    setNameDraft('')
                  }}
                  disabled={publishing}
                >
                  Cancel
                </button>
                <span className="hs-form-hint muted">
                  {picked.kind === 'zip'
                    ? 'ZIP — ' + picked.file.name
                    : picked.files.length + ' files · ' + humanizeBytes(picked.files.reduce((s, f) => s + f.size, 0))}
                </span>
              </div>
              {publishing && progress ? <div className="hs-progress">{progress}</div> : null}
            </div>
          )}
          {!publishing && progress ? <div className="hs-progress">{progress}</div> : null}
        </div>
      </section>

      {/* hidden inputs for the per-card Update buttons */}
      <input
        id="site-update-input"
        ref={setFolderInput}
        type="file"
        className="hs-file"
        onChange={(e) => onUpdatePick(e, 'site')}
        multiple
        aria-hidden="true"
        tabIndex={-1}
      />
      <input
        id="app-update-input"
        ref={setFolderInput}
        type="file"
        className="hs-file"
        onChange={(e) => onUpdatePick(e, 'app')}
        multiple
        aria-hidden="true"
        tabIndex={-1}
      />

      <section className="hs-block">
        <div className="hs-label muted">Websites</div>
        {sitesList === null ? (
          <div className="hs-card glass" aria-hidden="true">
            {[0, 1].map((i) => (
              <div key={i} className="hs-sk-row">
                <div className="skeleton hs-sk-line" style={{ width: i === 0 ? 160 : 120 }} />
                <div className="skeleton hs-sk-line" style={{ width: 90 }} />
              </div>
            ))}
          </div>
        ) : sitesList.length === 0 ? (
          <div className="empty">
            <div className="btn iconbtn" aria-hidden="true">
              <Icon name="globe" size={22} />
            </div>
            Host your first website. Pick a folder — it is live in seconds, on this phone, free.
          </div>
        ) : (
          sitesList.map((site) => {
            const u = usageByName[site.name]
            const files = u && typeof u.files === 'number' ? u.files : site.fileCount
            const bytes = u && typeof u.bytes === 'number' ? u.bytes : site.bytes
            const h = siteHealth[site.name]
            const url = siteUrl(site.name)
            return (
              <section key={site.name} className="hs-card glass">
                <div className="hs-card-head">
                  <div className="hs-card-title">
                    <span className={'hs-dot' + (h ? (h.up ? ' is-live' : ' is-dead') : '')} aria-hidden="true" />
                    <span className="hs-name">{site.name}</span>
                    <span className="chip">
                      {files} {files === 1 ? 'file' : 'files'}
                    </span>
                    <span className="chip">{humanizeBytes(bytes)}</span>
                    {h && !h.up && <span className="chip chip-warn">HTTP {h.status || 'down'}</span>}
                  </div>
                  <div className="hs-card-actions">
                    <button
                      className="btn"
                      onClick={() => askUpdate('site', site.name)}
                      disabled={busyName === site.name}
                      title="Upload a fresh folder over this site"
                    >
                      <Icon name="refresh" size={14} /> Update
                    </button>
                    {confirmName === site.name ? (
                      <button
                        className="btn btn-danger hs-sure"
                        onClick={() => removeSite(site)}
                        disabled={busyName === site.name}
                      >
                        Sure?
                      </button>
                    ) : (
                      <button
                        className="btn iconbtn btn-danger"
                        onClick={() => askRemove(site.name)}
                        aria-label={'Delete ' + site.name}
                        title="Delete"
                        disabled={busyName === site.name}
                      >
                        <Icon name="trash" size={15} />
                      </button>
                    )}
                  </div>
                </div>
                <div className="hs-urlrow">
                  <a className="hs-url" href={url} target="_blank" rel="noreferrer">
                    {url}
                  </a>
                  <button className="btn iconbtn" onClick={() => copyUrl(url)} aria-label="Copy link" title="Copy link">
                    <Icon name="copy" size={14} />
                  </button>
                  <button className="btn iconbtn" onClick={() => shareUrl(url, site.name)} aria-label="Share" title="Share">
                    <Icon name="share" size={14} />
                  </button>
                  <button
                    className="btn iconbtn"
                    onClick={() => setPreviewSite(previewSite === site.name ? null : site.name)}
                    aria-label="Preview"
                    aria-expanded={previewSite === site.name}
                    title="Preview"
                  >
                    <Icon name="eye" size={14} />
                  </button>
                </div>
                {previewSite === site.name && (
                  <div className="hs-preview">
                    <iframe title={'Preview of ' + site.name} src={'/s/' + site.name + '/'} loading="lazy" />
                  </div>
                )}
                <div className="hs-meta">
                  <CfPublish site={site.name} />
                  <span className="hs-created muted">hosted {timeAgo(site.createdAt)}</span>
                </div>
              </section>
            )
          })
        )}
      </section>

      <section className="hs-block">
        <div className="hs-label muted">Live apps</div>
        {appsList === null ? (
          <div className="hs-card glass" aria-hidden="true">
            <div className="hs-sk-row">
              <div className="skeleton hs-sk-line" style={{ width: 180 }} />
              <div className="skeleton hs-sk-line" style={{ width: 90 }} />
            </div>
          </div>
        ) : appsList.length === 0 ? (
          <div className="empty">
            <div className="btn iconbtn" aria-hidden="true">
              <Icon name="cpu" size={22} />
            </div>
            Host a real Node app — a tiny API, a bot, a backend. It gets its own port and runs
            24/7 on this phone.
          </div>
        ) : (
          appsList.map((app) => {
            const url = app.port ? appUrl(app.port) : null
            const isRunning = app.state === 'running'
            const isStarting = app.state === 'starting'
            return (
              <section key={app.name} className="hs-card glass" aria-label={'App ' + app.name}>
                <div className="hs-card-head">
                  <div className="hs-card-title">
                    <span
                      className={'hs-dot' + (isRunning ? ' is-live' : app.state === 'crashed' ? ' is-dead' : '')}
                      aria-hidden="true"
                    />
                    <span className="hs-name">{app.name}</span>
                    <span className={'chip ' + (isRunning ? 'chip-ok' : app.state === 'crashed' ? 'chip-warn' : '')}>
                      {app.state}
                    </span>
                    <span className="chip">{app.ramMB != null ? app.ramMB + ' MB' : 'ram —'}</span>
                    <span className="chip">
                      {app.fileCount} {app.fileCount === 1 ? 'file' : 'files'}
                    </span>
                    <span className="chip">{humanizeBytes(app.bytes)}</span>
                    {app.entry && <span className="chip">{app.entry}</span>}
                  </div>
                  <div className="hs-card-actions">
                    {isRunning || isStarting ? (
                      <button
                        className="btn"
                        onClick={() => appAct(app, 'stop')}
                        disabled={busyName === app.name + ':stop'}
                      >
                        <Icon name="stop" size={13} /> Stop
                      </button>
                    ) : (
                      <button
                        className="btn btn-primary"
                        onClick={() => startAppConfirm(app)}
                        disabled={busyName === app.name + ':start'}
                      >
                        <Icon name="play" size={13} /> Start
                      </button>
                    )}
                    <button
                      className={'btn' + (restartHint && restartHint[app.name] ? ' hs-restart-pulse' : '')}
                      onClick={() => appAct(app, 'restart')}
                      disabled={busyName === app.name + ':restart' || app.state === 'stopped'}
                      title={app.state === 'stopped' ? 'Start it first' : 'Restart the process'}
                    >
                      <Icon name="refresh" size={13} /> Restart
                    </button>
                    <button
                      className="btn"
                      onClick={() => askUpdate('app', app.name)}
                      disabled={busyName === app.name}
                    >
                      <Icon name="upload" size={13} /> Update
                    </button>
                    {confirmName === app.name ? (
                      <button className="btn btn-danger hs-sure" onClick={() => removeApp(app)} disabled={busyName === app.name}>
                        Sure?
                      </button>
                    ) : (
                      <button
                        className="btn iconbtn btn-danger"
                        onClick={() => askRemove(app.name)}
                        aria-label={'Delete ' + app.name}
                        title="Delete"
                        disabled={busyName === app.name}
                      >
                        <Icon name="trash" size={15} />
                      </button>
                    )}
                  </div>
                </div>
                <div className="hs-urlrow">
                  {url ? (
                    <>
                      <a className="hs-url" href={url} target="_blank" rel="noreferrer">
                        {url}
                      </a>
                      <button className="btn iconbtn" onClick={() => copyUrl(url)} aria-label="Copy app link" title="Copy app link">
                        <Icon name="copy" size={14} />
                      </button>
                      <button className="btn iconbtn" onClick={() => shareUrl(url, app.name)} aria-label="Share" title="Share">
                        <Icon name="share" size={14} />
                      </button>
                    </>
                  ) : (
                    <span className="muted">Stopped — start it to get its link.</span>
                  )}
                </div>
                <div className="hs-btnrow">
                  <button
                    className="btn"
                    onClick={() => setEditorFile('apps/' + app.name + '/' + (app.entry || 'index.js'))}
                    title={'Edit ' + (app.entry || 'index.js')}
                  >
                    <Icon name="code" size={13} /> Edit code
                  </button>
                  <button
                    className="btn"
                    onClick={() => {
                      setOpenLogs(openLogs === app.name ? null : app.name)
                      setLogs([])
                    }}
                    aria-expanded={openLogs === app.name}
                  >
                    <Icon name="file" size={13} /> {openLogs === app.name ? 'Hide logs' : 'Logs'}
                  </button>
                  <button className="btn" onClick={() => doExport(app)} disabled={busyName === app.name + ':export'}>
                    <Icon name="download" size={13} /> Export
                  </button>
                  <AppEnv app={app} busy={busyName === app.name + ':env'} onSave={saveEnv} />
                </div>
                {restartHint && restartHint[app.name] && (
                  <div className="hs-restart-note muted">
                    Code saved — hit Restart to serve the new version.
                  </div>
                )}
                {openLogs === app.name && (
                  <pre className="hs-logs">
                    {logs.length === 0 ? 'No output yet.' : logs.slice(-40).join('\n')}
                  </pre>
                )}
                <div className="hs-meta">
                  <span className="muted">
                    Runs on this phone with its own port. Publish to Cloudflare is for static sites —
                    for a public URL use Tools below. Registered {timeAgo(app.createdAt)}.
                  </span>
                </div>
              </section>
            )
          })
        )}
      </section>

      <Tools sites={sitesList === null ? [] : sitesList} />

      {editorFile && (
        <CodeEditor
          path={editorFile}
          onClose={(saved) => {
            const appMatch = editorFile.match(/^apps\/([a-z0-9-]+)\//)
            if (saved && appMatch) {
              setRestartHint((cur) => ({ ...cur, [appMatch[1]]: true }))
            }
            setEditorFile(null)
            load(false)
          }}
        />
      )}
    </div>
  )
}

// --- per-app env editor (key/value rows, saved as a whole) ---
function AppEnv({ app, busy, onSave }) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState([])
  useEffect(() => {
    if (open) {
      const entries = Object.entries(app.env || {})
      setRows(entries.length ? entries.map(([k, v]) => ({ k, v })) : [{ k: '', v: '' }])
    }
  }, [open, app.env])
  return (
    <details
      className="hs-env"
      onToggle={(e) => setOpen(e.target.open)}
    >
      <summary className="btn">
        <Icon name="lock" size={13} /> Env
      </summary>
      <div className="hs-env-body">
        {rows.map((row, i) => (
          <div key={i} className="hs-env-row">
            <input
              placeholder="NAME"
              value={row.k}
              onChange={(e) =>
                setRows((cur) => cur.map((r, j) => (j === i ? { ...r, k: e.target.value } : r)))
              }
              aria-label={'Env name ' + (i + 1)}
              spellCheck={false}
              autoCapitalize="off"
            />
            <input
              placeholder="value"
              value={row.v}
              onChange={(e) =>
                setRows((cur) => cur.map((r, j) => (j === i ? { ...r, v: e.target.value } : r)))
              }
              aria-label={'Env value ' + (i + 1)}
              spellCheck={false}
            />
            <button
              className="btn iconbtn"
              onClick={() => setRows((cur) => cur.filter((_, j) => j !== i))}
              aria-label={'Remove env row ' + (i + 1)}
              title="Remove"
            >
              <Icon name="x" size={13} />
            </button>
          </div>
        ))}
        <div className="hs-env-actions">
          <button className="btn" onClick={() => setRows((cur) => [...cur, { k: '', v: '' }])}>
            <Icon name="plus" size={13} /> Add
          </button>
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={() => {
              const env = {}
              for (const r of rows) {
                if (r.k.trim()) env[r.k.trim()] = r.v
              }
              onSave(app, env)
              setOpen(false)
            }}
          >
            Save env
          </button>
        </div>
        <span className="muted hs-env-note">Reach the app as process.env.NAME — restart to apply.</span>
      </div>
    </details>
  )
}
