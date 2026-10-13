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
  uploadAppZip,
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
// every write is a plain fetch. Upload progress is inline text so
// it stays visible while batches are in flight.

const POLL_MS = 30000
const APP_POLL_MS = 3000
const NAME_RE = /^[a-z0-9-]{1,32}$/
const BATCH_FILES = 100
const BATCH_BYTES = 64 * 1024 * 1024 // one multipart request stays comfortably under body limits

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

const uploadSiteZip = (name, file) => {
  const fd = new FormData()
  fd.append('zip', file)
  return fetch('/api/sites/' + encodeURIComponent(name) + '/zip', {
    method: 'POST',
    body: fd
  }).then(j)
}

const siteUsageReq = (name) => fetch('/api/sites/' + encodeURIComponent(name) + '/usage').then(j)

// Multipart folder upload: each part's field name is the target path inside
// the project, so deep folders and big files survive without base64 or a
// per-file size cliff. Bounded per request so one stall cannot lose everything.
async function uploadFolderMultipart(url, files, relOf, onProgress) {
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
  if (cur.length > 0) batches.push(cur)
  let done = 0
  for (const batch of batches) {
    const fd = new FormData()
    for (const f of batch) fd.append(relOf(f), f, f.name)
    await j(await fetch(url, { method: 'POST', body: fd }))
    done += batch.length
    if (onProgress) onProgress(done, files.length)
  }
  return done
}

// Inside the Android app the WebView cannot hand a folder with its structure
// (webkitdirectory is desktop-only), so the app offers a native picker that
// streams the tree itself and reports back through these window callbacks.
const nativeHost = () => (window.MittiCloud && window.MittiCloud.pickFolder ? window.MittiCloud : null)

const deleteSite = (name) =>
  fetch('/api/sites/' + encodeURIComponent(name), { method: 'DELETE' }).then(j)

// webkitRelativePath minus the top-level folder name ("site/css/a.css" -> "css/a.css").
function relPath(f) {
  const p = String(f.webkitRelativePath || f.name).replace(/\\/g, '/')
  const parts = p.split('/')
  return (parts.length > 1 ? parts.slice(1) : parts).join('/') || f.name
}

// The app's picker reports paths relative to the picked folder, top directory
// included ("site/css/a.css"). Shape them like File objects so relPath,
// detectKind and the size summaries all work unchanged.
function normalizeNativeFiles(rep) {
  return (rep.files || []).map((f) => {
    const p = String(f.path || '').replace(/\\/g, '/')
    const parts = p.split('/')
    return {
      webkitRelativePath: p,
      name: parts[parts.length - 1] || p,
      size: Number(f.size) || 0,
    }
  })
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

// Human words for a dead site, mapped from what the deep health check saw:
// a 404 means nothing answers at the root, any other HTTP status means the
// server spoke, and a bare error string means we never reached it at all.
function siteDiagnosis(h) {
  if (!h || h.up) return null
  if (h.status === 404) {
    return "Nothing answers at / — the site's files may be missing an index.html at the root. Update re-uploads them."
  }
  if (h.status) {
    return 'The server answered HTTP ' + h.status + " — open it to see what's wrong."
  }
  if (h.error) return 'Not reachable right now — it may come back, or it was removed.'
  return null
}

// The one word a row shows for an app: the deploy step while it is in progress
// or failed, otherwise its run state. Plain words, no internal state names.
function appStatusWord(app) {
  const step = app.deployStep || ''
  if (step === 'waiting') return 'Waiting for the build before yours'
  if (step === 'installing') return 'Installing'
  if (step === 'building') return 'Building'
  if (step === 'starting') return 'Starting'
  if (step.startsWith('failed:')) return 'Failed at ' + step.slice(7)
  if (app.state === 'running') return 'Live'
  if (app.state === 'starting') return 'Starting'
  if (app.state === 'crashed') return 'Crashed'
  return 'Stopped'
}

export default function HostPanel() {
  const [sites, setSites] = useState(null) // null = loading
  const [apps, setApps] = useState(null)
  const [siteHealth, setSiteHealth] = useState({}) // name -> {up, status}
  const [usageByName, setUsageByName] = useState({})

  // add flow
  const [picked, setPicked] = useState(null) // {kind:'folder'|'zip', files?, file?, suggested}
  const [nativePicked, setNativePicked] = useState(null) // {files:[{path,size}]} from the app's picker
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
  const folderInputRef = useRef(null)
  const nativeTargetRef = useRef(null) // card being updated when the app picker answers
  const nativeDoneRef = useRef(null) // resolver for the app's upload report
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
      for (const r of d.sites?.results || []) map[r.name] = { up: r.up, status: r.status, error: r.error, hint: r.hint }
      setSiteHealth(map)
    } catch {
      /* the dots just stay dim */
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    load()
    loadHealth()
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

  // The app streams the picked tree itself and reports through these window
  // callbacks; the promise resolves with the server's answer.
  const nativeUpload = (target, name) =>
    new Promise((resolve) => {
      nativeDoneRef.current = (json) => {
        let r = null
        try {
          r = JSON.parse(json)
        } catch {
          r = null
        }
        resolve(r && typeof r.ok === 'boolean' ? r : { ok: false, error: 'Bad upload report from the app' })
      }
      nativeHost().uploadPicked(target, name)
    })

  const updateWithNative = async (target, name, files) => {
    setBusyName(name)
    setProgress('Uploading 0/' + files.length)
    try {
      const r = await nativeUpload(target === 'app' ? 'apps' : 'sites', name)
      if (!r.ok) throw new Error(r.error || 'The phone could not store the folder')
      if (target === 'app') {
        setProgress('Restarting…')
        await deployApp(name, files.some((f) => relPath(f) === 'package.json'))
        setLive({ kind: 'app', name, url: null })
        toast('App updated and restarted', 'ok')
        await load(false)
      } else {
        setLive({ kind: 'site', name, url: siteUrl(name) })
        toast('Site updated', 'ok')
        await load(true)
        loadHealth()
      }
    } catch (err) {
      toast(err.message || 'Could not update', 'err')
    } finally {
      if (mountedRef.current) {
        setBusyName(null)
        setProgress('')
      }
    }
  }

  useEffect(() => {
    window.onNativeFolderPicked = (json) => {
      let rep = null
      try {
        rep = JSON.parse(json)
      } catch {
        rep = null
      }
      if (!rep || !Array.isArray(rep.files) || rep.files.length === 0) {
        toast((rep && rep.error) || 'No files came back from the folder picker', 'err')
        return
      }
      const files = normalizeNativeFiles(rep)
      const target = nativeTargetRef.current
      nativeTargetRef.current = null
      if (target) {
        updateWithNative(target.target, target.name, files)
        return
      }
      const suggested = suggestName(String(files[0].webkitRelativePath || '').split('/')[0])
      nameTouchedRef.current = false
      setPicked(null)
      setNativePicked({ files })
      setNameDraft(suggested)
      setKind(detectKind(files.map(relPath)))
    }
    window.onNativeUploadProgress = (json) => {
      try {
        const p = JSON.parse(json)
        if (mountedRef.current) setProgress('Uploading ' + p.done + '/' + p.total)
      } catch {
        /* a malformed progress line is not worth a toast */
      }
    }
    window.onNativeUploadDone = (json) => {
      const done = nativeDoneRef.current
      nativeDoneRef.current = null
      if (done) done(json)
    }
    return () => {
      delete window.onNativeFolderPicked
      delete window.onNativeUploadProgress
      delete window.onNativeUploadDone
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
    const source = nativePicked ? { kind: 'native', files: nativePicked.files } : picked
    if (!siteName || !source || publishing) return
    setPublishing(true)
    try {
      if (kind === 'app') await publishApp(siteName, source)
      else await publishSite(siteName, source)
      setNativePicked(null)
    } finally {
      if (mountedRef.current) setPublishing(false)
    }
  }

  const publishSite = async (siteName, source) => {
    setProgress('Creating ' + siteName + '…')
    try {
      try {
        await createSite(siteName)
      } catch (err) {
        if (err.status !== 409) throw err
        toast('Already exists — updating its files', 'info')
      }
      if (source.kind === 'zip') {
        setProgress('Publishing zip…')
        const r = await uploadSiteZip(siteName, source.file)
        const n = r && typeof r.files === 'number' ? r.files : null
        toast(n != null ? 'Published ' + n + ' files' : 'Site published', 'ok')
      } else if (source.kind === 'native') {
        const r = await nativeUpload('sites', siteName)
        if (!r.ok) throw new Error(r.error || 'The phone could not store the folder')
        toast('Published ' + (r.written || source.files.length) + ' files', 'ok')
      } else {
        setProgress('Uploading 0/' + source.files.length)
        await uploadFolderMultipart(
          '/api/sites/' + encodeURIComponent(siteName) + '/upload',
          source.files,
          relPath,
          (done, total) => mountedRef.current && setProgress('Uploading ' + done + '/' + total)
        )
      }
      setLive({ kind: 'site', name: siteName, url: siteUrl(siteName) })
      setPicked(null)
      setNameDraft('')
      await load(true)
      loadHealth()
    } catch (err) {
      toast(err.message || 'Could not publish the site', 'err')
    } finally {
      if (mountedRef.current) setProgress('')
    }
  }

  const publishApp = async (appName, source) => {
    const hasPkg =
      source.kind === 'zip' ? true : source.files.some((f) => relPath(f) === 'package.json')
    if (hasPkg && !window.confirm('This takes a few minutes and warms the phone. Start?')) {
      setProgress('')
      return
    }
    setProgress('Creating ' + appName + '…')
    try {
      try {
        await createApp(appName)
      } catch (err) {
        if (err.status !== 409) throw err
        toast('Already exists — updating its files', 'info')
      }
      if (source.kind === 'zip') {
        setProgress('Publishing zip…')
        await uploadAppZip(appName, source.file)
      } else if (source.kind === 'native') {
        const r = await nativeUpload('apps', appName)
        if (!r.ok) throw new Error(r.error || 'The phone could not store the folder')
      } else {
        setProgress('Uploading 0/' + source.files.length)
        await uploadFolderMultipart(
          '/api/apps/' + encodeURIComponent(appName) + '/upload',
          source.files,
          relPath,
          (done, total) => mountedRef.current && setProgress('Uploading ' + done + '/' + total)
        )
      }
      setProgress(hasPkg ? 'Installing packages…' : 'Starting…')
      const r = await deployApp(appName, hasPkg)
      setLive({ kind: 'app', name: appName, url: appUrl(r.port), port: r.port })
      toast((hasPkg ? 'Packages installed — a' : 'A') + 'pp is live', 'ok')
      setPicked(null)
      setNameDraft('')
      await load(false)
    } catch (err) {
      toast(err.message || 'Could not deploy the app', 'err')
    } finally {
      if (mountedRef.current) setProgress('')
    }
  }

  // --- update an existing card with a fresh folder/zip pick ---
  const askUpdate = (target, name) => {
    if (nativeHost()) {
      nativeTargetRef.current = { target, name }
      nativeHost().pickFolder()
      return
    }
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
        setProgress('Updating ' + meta.name + '…')
        try {
          await createSite(meta.name)
        } catch (err) {
          if (err.status !== 409) throw err
        }
        await uploadFolderMultipart(
          '/api/sites/' + encodeURIComponent(meta.name) + '/upload',
          files,
          relPath,
          (done, total) => mountedRef.current && setProgress('Uploading ' + done + '/' + total)
        )
        setLive({ kind: 'site', name: meta.name, url: siteUrl(meta.name) })
        toast('Site updated', 'ok')
        await load(true)
        loadHealth()
      } else {
        const hasPkg = files.some((f) => relPath(f) === 'package.json')
        setProgress('Updating ' + meta.name + '…')
        await uploadFolderMultipart(
          '/api/apps/' + encodeURIComponent(meta.name) + '/upload',
          files,
          relPath,
          (done, total) => mountedRef.current && setProgress('Uploading ' + done + '/' + total)
        )
        setProgress(hasPkg ? 'Installing packages…' : 'Restarting…')
        await deployApp(meta.name, hasPkg)
        setLive({ kind: 'app', name: meta.name, url: null })
        toast('App updated and restarted', 'ok')
        await load(false)
      }
    } catch (err) {
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
      toast(err.message || 'Could not delete the app', 'err')
    } finally {
      if (mountedRef.current) setBusyName(null)
    }
  }

  const saveRun = async (app, cmds) => {
    setBusyName(app.name + ':run')
    try {
      await updateAppConfig(app.name, cmds)
      toast('Run settings saved — restart the app to apply', 'ok')
      setRestartHint((cur) => ({ ...cur, [app.name]: true }))
      load(false)
    } catch (err) {
      toast(err.message || 'Could not save run settings', 'err')
    } finally {
      setBusyName(null)
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
          <div className="hs-subtitle muted">Put a project online, from this phone.</div>
        </div>
      </div>

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
        <div className="hs-label muted">Add a project</div>
        <div className="hs-form glass">
          {!picked && !nativePicked ? (
            <div className="hs-form-row">
              <button
                className="btn btn-primary"
                disabled={publishing}
                onClick={() => {
                  if (nativeHost()) nativeHost().pickFolder()
                  else if (folderInputRef.current) folderInputRef.current.click()
                }}
              >
                <Icon name="upload" size={15} />
                Choose a folder
              </button>
              <input
                ref={(el) => {
                  folderInputRef.current = el
                  setFolderInput(el)
                }}
                type="file"
                className="hs-file"
                onChange={pickFolder}
                multiple
                disabled={publishing}
                aria-label="Choose a folder to host"
                tabIndex={-1}
              />
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
                Any folder works. Websites in every language host as they are; a folder with a
                package.json (Next.js, Express, any Node project) runs as a live app with a real
                backend.
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
                <span className="hs-kind-note muted">
                  {kind === 'app'
                    ? 'Detected: a project that runs on the phone (Node.js backend). It installs and builds itself.'
                    : 'Detected: a website. Every file type hosts — HTML, CSS, JS, images, fonts, video.'}
                </span>
              </div>
              <div className="hs-confirm-row">
                <button className="btn btn-primary" disabled={publishing} onClick={publish}>
                  {publishing && <span className="spin" aria-hidden="true" />}
                  {publishing ? 'Adding...' : 'Add project'}
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    setPicked(null)
                    setNativePicked(null)
                    setNameDraft('')
                  }}
                  disabled={publishing}
                >
                  Cancel
                </button>
                <span className="hs-form-hint muted">
                  {nativePicked
                    ? nativePicked.files.length +
                      ' files · ' +
                      humanizeBytes(nativePicked.files.reduce((s, f) => s + (f.size || 0), 0))
                    : picked.kind === 'zip'
                      ? 'ZIP — ' + picked.file.name
                      : picked.files.length +
                        ' files · ' +
                        humanizeBytes(picked.files.reduce((s, f) => s + f.size, 0))}
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

      <section className="hs-block stag">
        <div className="hs-label muted">Your projects</div>
        {sitesList === null || appsList === null ? (
          <div className="hs-card glass" aria-hidden="true">
            {[0, 1].map((i) => (
              <div key={i} className="hs-sk-row">
                <div className="skeleton hs-sk-line" style={{ width: i === 0 ? 160 : 120 }} />
                <div className="skeleton hs-sk-line" style={{ width: 90 }} />
              </div>
            ))}
          </div>
        ) : sitesList.length === 0 && appsList.length === 0 ? (
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
            const diag = (h && h.hint) || siteDiagnosis(h)
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
                {diag && <div className="hs-diag">{diag}</div>}
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
                <div className={'xwrap' + (previewSite === site.name ? ' open' : '')}>
                  <div>
                    <div className="hs-preview">
                      <iframe title={'Preview of ' + site.name} src={'/s/' + site.name + '/'} loading="lazy" />
                    </div>
                  </div>
                </div>
                <div className="hs-meta">
                  <CfPublish site={site.name} />
                  <span className="hs-created muted">hosted {timeAgo(site.createdAt)}</span>
                </div>
              </section>
            )
          })
        )}
        {appsList === null ? null : (
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
                    <span className={'chip ' + (isRunning ? 'chip-ok' : app.state === 'crashed' || (app.deployStep || '').startsWith('failed') ? 'chip-warn' : '')}>
                      {appStatusWord(app)}
                    </span>
                    <span className="chip">{app.ramMB != null ? app.ramMB + ' MB' : 'ram —'}</span>
                    <span className="chip">
                      {app.fileCount} {app.fileCount === 1 ? 'file' : 'files'}
                    </span>
                    <span className="chip">{humanizeBytes(app.bytes)}</span>
                    {app.entry && <span className="chip">{app.entry}</span>}
                    {!app.entry && app.startCommand && (
                      <span className="chip" title="Custom start command">
                        {app.startCommand}
                      </span>
                    )}
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
                  <AppRun app={app} busy={busyName === app.name + ':run'} onSave={saveRun} />
                </div>
                {restartHint && restartHint[app.name] && (
                  <div className="hs-restart-note muted">
                    Code saved — hit Restart to serve the new version.
                  </div>
                )}
                <div className={'xwrap' + (openLogs === app.name ? ' open' : '')}>
                  <div>
                    <pre className="hs-logs">
                      {openLogs === app.name
                        ? logs.length === 0
                          ? 'No output yet.'
                          : logs.slice(-40).join('\n')
                        : ''}
                    </pre>
                  </div>
                </div>
                <div className="hs-meta">
                  <span className="muted">
                    Running server — Cloudflare Pages can only host static files. For a public link, use the
                    tunnel under Tools below. Added {timeAgo(app.createdAt)}.
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
    <div className={'hs-env' + (open ? ' open' : '')}>
      <button type="button" className="btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="lock" size={13} /> Env
      </button>
      <div className={'xwrap' + (open ? ' open' : '')}>
        <div>
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
        </div>
      </div>
    </div>
  )
}

// --- per-app run settings: the commands that install and start it (any language) ---
function AppRun({ app, busy, onSave }) {
  const [open, setOpen] = useState(false)
  const [startCmd, setStartCmd] = useState('')
  const [installCmd, setInstallCmd] = useState('')
  useEffect(() => {
    if (open) {
      setStartCmd(app.startCommand || '')
      setInstallCmd(app.installCommand || '')
    }
  }, [open, app.startCommand, app.installCommand])
  return (
    <div className={'hs-env' + (open ? ' open' : '')}>
      <button type="button" className="btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="code" size={13} /> Run
      </button>
      <div className={'xwrap' + (open ? ' open' : '')}>
        <div>
          <div className="hs-env-body">
            <label className="hs-run-label" htmlFor={'run-start-' + app.name}>
              Start command
            </label>
            <input
              id={'run-start-' + app.name}
              placeholder="python app.py · php -S 0.0.0.0:%PORT% · node server.js"
              value={startCmd}
              onChange={(e) => setStartCmd(e.target.value)}
              spellCheck={false}
              autoCapitalize="off"
            />
            <label className="hs-run-label" htmlFor={'run-install-' + app.name}>
              Install command (optional)
            </label>
            <input
              id={'run-install-' + app.name}
              placeholder="pip install -r requirements.txt"
              value={installCmd}
              onChange={(e) => setInstallCmd(e.target.value)}
              spellCheck={false}
              autoCapitalize="off"
            />
            <div className="hs-env-actions">
              <button
                className="btn btn-primary"
                disabled={busy}
                onClick={() => {
                  onSave(app, { startCommand: startCmd.trim(), installCommand: installCmd.trim() })
                  setOpen(false)
                }}
              >
                Save run settings
              </button>
            </div>
            <span className="muted hs-env-note">
              Runs in the app folder with PORT set — any language this device can execute. On
              Windows use %PORT% inside the command; elsewhere $PORT. Leave both empty for the
              automatic Node detection. Restart to apply.
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
