import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../icons.jsx'
import {
  toast,
  timeAgo,
  humanizeBytes,
  tokenHeaders,
  copyText,
  fetchBridgePairing,
  shareOrCopy,
  fetchStatus,
  fetchHostLan,
  fetchTunnel
} from '../api.js'
import './RemotePanel.css'

// Remote — three plain steps: see this cloud from other devices, bring a
// laptop's project here, and use ZCode from the phone (ZCode's own feature).
const MAX_FILE_BYTES = 5 * 1024 * 1024
const BATCH_FILES = 25
const BATCH_BYTES = 40 * 1024 * 1024

async function j(res) {
  const d = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(d.error || res.statusText), { status: res.status })
  return d
}

const listSessions = () => fetch('/api/bridge/sessions').then(j).then((d) => d.sessions || [])
const createSession = (name) =>
  fetch('/api/bridge/sessions', {
    method: 'POST',
    headers: tokenHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ name })
  }).then(j)
const deleteSession = (id) =>
  fetch('/api/bridge/sessions/' + encodeURIComponent(id), { method: 'DELETE', headers: tokenHeaders() }).then(j)
const newChat = (id) =>
  fetch('/api/bridge/sessions/' + encodeURIComponent(id) + '/new-chat', { method: 'POST', headers: tokenHeaders() }).then(j)
const uploadFiles = (id, files) =>
  fetch('/api/bridge/sessions/' + encodeURIComponent(id) + '/files', {
    method: 'POST',
    headers: tokenHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ files })
  }).then(j)
const resumeSession = async (id) => {
  const chat = await fetch('/api/bridge/sessions/' + encodeURIComponent(id) + '/chat').then(j).catch(() => ({ messages: [] }))
  const ctx = await fetch('/api/bridge/sessions/' + encodeURIComponent(id) + '/context')
    .then((r) => (r.ok ? r.text() : ''))
    .catch(() => '')
  const messages = chat.messages || []
  const lines = [ctx || '(no context saved for this session)', '', '--- chat (' + messages.length + ' messages) ---']
  for (const m of messages) lines.push('[' + m.role + '] ' + (m.text || ''))
  return lines.join('\n')
}

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

function relPath(f) {
  const p = String(f.webkitRelativePath || f.name).replace(/\\/g, '/')
  const parts = p.split('/')
  return (parts.length > 1 ? parts.slice(1) : parts).join('/') || f.name
}

// --- DEVICES · pairing a laptop (the bridge, in plain words) ---

function PairLaptop() {
  const [pair, setPair] = useState(null)
  useEffect(() => {
    let alive = true
    fetchBridgePairing()
      .then((d) => alive && setPair(d))
      .catch(() => alive && setPair(null))
    return () => {
      alive = false
    }
  }, [])
  if (!pair) return null
  return (
    <div className="rp-pair glass">
      <div className="rp-pair-title">
        <Icon name="link" size={14} /> Pair your laptop
      </div>
      <p className="muted">
        On any laptop with Node, one command fills a memory with a whole project folder — the files
        land here, resumable from any device.
      </p>
      <div className="rp-pair-cmd">
        <code>{pair.command}</code>
        <button
          className="btn iconbtn"
          aria-label="Copy the pairing command"
          title="Copy"
          onClick={async () => {
            const ok = await copyText(pair.command)
            toast(ok ? 'Command copied' : "Couldn't copy — select it manually", ok ? 'ok' : 'info')
          }}
        >
          <Icon name="copy" size={14} />
        </button>
      </div>
      {pair.needsToken && (
        <div className="muted rp-pair-note">
          Your cloud is locked — set MITTI_TOKEN=&lt;your access token&gt; in the same terminal
          first.
        </div>
      )}
    </div>
  )
}

// --- DEVICES · project memory (the bridge, in plain words) ---

function ProjectMemory() {
  const [sessions, setSessions] = useState(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [resumed, setResumed] = useState(null)
  const [confirmId, setConfirmId] = useState(null)
  const alive = useRef(true)

  const load = useCallback(() => {
    listSessions()
      .then((s) => alive.current && setSessions(s))
      .catch(() => alive.current && setSessions([]))
  }, [])

  useEffect(() => {
    alive.current = true
    load()
    return () => {
      alive.current = false
    }
  }, [load])

  const create = async () => {
    const n = name.trim()
    if (!n) {
      toast('Give the memory a name first', 'info')
      return
    }
    setBusy(true)
    try {
      await createSession(n)
      toast('Memory created', 'ok')
      setName('')
      load()
    } catch (err) {
      toast(err.message, 'err')
    } finally {
      setBusy(false)
    }
  }

  const doUpload = async (e, id) => {
    const picked = Array.from(e.target.files || [])
    e.target.value = ''
    if (!picked.length) return
    const tooBig = picked.filter((f) => f.size > MAX_FILE_BYTES)
    const usable = picked.filter((f) => f.size <= MAX_FILE_BYTES)
    setBusy(true)
    try {
      const batches = []
      let cur = []
      let curBytes = 0
      for (const f of usable) {
        if (cur.length && (cur.length >= BATCH_FILES || curBytes + f.size > BATCH_BYTES)) {
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
        const files = []
        for (const f of batch) files.push({ path: relPath(f), contentBase64: await readAsBase64(f) })
        await uploadFiles(id, files)
        done += batch.length
        setProgress('Uploading ' + done + '/' + usable.length)
      }
      toast('Uploaded ' + usable.length + ' file(s)' + (tooBig.length ? ' — skipped ' + tooBig.length + ' over 5 MB' : ''), 'ok')
      load()
    } catch (err) {
      toast(err.message, 'err')
    } finally {
      setBusy(false)
      setProgress('')
    }
  }

  const doResume = async (s) => {
    setBusy(true)
    try {
      setProgress('Loading context and chat…')
      const text = await resumeSession(s.id)
      setResumed({ id: s.id, text })
      const copied = await copyText(text)
      toast(
        copied
          ? 'Copied — paste it into your agent'
          : "Couldn't copy — long-press the box below to copy it",
        copied ? 'ok' : 'info'
      )
    } catch (err) {
      toast(err.message, 'err')
    } finally {
      setBusy(false)
      setProgress('')
    }
  }

  const doNewChat = async (s) => {
    if (!window.confirm('Start a new chat for "' + s.name + '"? Context is kept, chat is cleared.')) return
    try {
      await newChat(s.id)
      toast('New chat started — context kept', 'ok')
      load()
    } catch (err) {
      toast(err.message, 'err')
    }
  }

  const doDownload = async (s) => {
    try {
      const ctx = await fetch('/api/bridge/sessions/' + encodeURIComponent(s.id) + '/context')
        .then((r) => (r.ok ? r.text() : ''))
        .catch(() => '')
      const blob = new Blob([ctx || ''], { type: 'text/plain' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = s.name + '-context.txt'
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 4000)
      toast('Context downloaded', 'ok')
    } catch (err) {
      toast(err.message || 'Could not download the context', 'err')
    }
  }

  const doDelete = async (s) => {
    if (confirmId !== s.id) {
      setConfirmId(s.id)
      setTimeout(() => alive.current && setConfirmId(null), 3500)
      return
    }
    try {
      await deleteSession(s.id)
      toast('Memory deleted', 'ok')
      setConfirmId(null)
      load()
    } catch (err) {
      toast(err.message, 'err')
    }
  }

  return (
    <div className="rp-memory">
      <PairLaptop />
      <p className="rp-story muted">
        Store your project files and coding-agent context on this phone. Resume your work from any
        device — the <b>mitti-bridge</b> CLI on your laptop uses these same memories.
      </p>
      <div className="rp-actions">
        <input
          placeholder="Name a memory — like: my-store"
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') create()
          }}
        />
        <button className="btn btn-primary" disabled={busy} onClick={create}>
          <Icon name="plus" size={15} /> New memory
        </button>
      </div>
      {progress && <div className="rp-progress muted">{progress}</div>}

      {sessions === null ? (
        <div className="rp-card glass" aria-hidden="true">
          <div className="skeleton rp-sk-line" style={{ width: 160 }} />
        </div>
      ) : sessions.length === 0 ? (
        <div className="empty">
          <div className="btn iconbtn" aria-hidden="true">
            <Icon name="link" size={22} />
          </div>
          No memories yet — create one, then fill it from your laptop with the mitti-bridge CLI or
          the upload button.
        </div>
      ) : (
        <div className="rp-cards stag">
          {sessions.map((s) => (
            <section key={s.id} className="rp-card glass">
              <div className="rp-card-head">
                <div className="rp-card-title">
                  <span className="rp-name">{s.name}</span>
                  <span className="muted rp-meta">
                    {s.fileCount} files · {humanizeBytes(s.contextBytes)} context · {s.chatCount} chats ·{' '}
                    {timeAgo(s.updatedAt)}
                  </span>
                </div>
                <div className="rp-card-actions">
                  {confirmId === s.id ? (
                    <button className="btn btn-danger" onClick={() => doDelete(s)}>
                      Sure?
                    </button>
                  ) : (
                    <button className="btn iconbtn btn-danger" aria-label={'Delete ' + s.name} onClick={() => doDelete(s)}>
                      <Icon name="trash" size={15} />
                    </button>
                  )}
                </div>
              </div>
              <div className="rp-actions">
                <label className="btn">
                  <Icon name="upload" size={14} /> Upload folder
                  <input
                    type="file"
                    className="rp-file"
                    webkitdirectory=""
                    multiple
                    disabled={busy}
                    onChange={(e) => doUpload(e, s.id)}
                  />
                </label>
                <button className="btn" disabled={busy} onClick={() => doResume(s)}>
                  <Icon name="refresh" size={14} /> Copy context + chat
                </button>
                <button className="btn" disabled={busy} onClick={() => doDownload(s)}>
                  <Icon name="download" size={14} /> Download
                </button>
                <button className="btn" disabled={busy} onClick={() => doNewChat(s)}>
                  <Icon name="file" size={14} /> New chat
                </button>
              </div>
              {resumed && resumed.id === s.id && (
                <pre className="rp-pre">{resumed.text}</pre>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

// --- REACH · the real addresses of this cloud ---

function Reach() {
  const [status, setStatus] = useState(null)
  const [tunnel, setTunnel] = useState(null)
  const [lan, setLan] = useState(null)
  const [settled, setSettled] = useState(false)

  useEffect(() => {
    let alive = true
    let pending = 3
    const one = (p, set) => {
      p.then((d) => alive && set(d)).catch(() => {}).finally(() => {
        if (alive && --pending === 0) setSettled(true)
      })
    }
    one(fetchStatus(), setStatus)
    one(fetchTunnel(), setTunnel)
    one(fetchHostLan(), setLan)
    return () => {
      alive = false
    }
  }, [])

  const rows = []
  const ts = status && status.tailscale
  if (ts && ts.running && ts.dnsName) rows.push({ label: 'Tailscale', url: 'https://' + ts.dnsName })
  if (tunnel && tunnel.running && tunnel.url) rows.push({ label: 'Tunnel', url: tunnel.url })
  // LAN IPs: /api/host/lan first (it knows the port), status readout as backup
  const lanUrls = (lan && lan.urls) || (status && status.device && status.device.lanUrls) || []
  for (const u of lanUrls) {
    if (u && !rows.some((r) => r.url === u)) rows.push({ label: 'This network', url: u })
  }

  const copy = async (url) => {
    const ok = await copyText(url)
    toast(ok ? 'Address copied' : "Couldn't copy — select it manually", ok ? 'ok' : 'info')
  }
  const share = async (url) => {
    const r = await shareOrCopy(url, 'MittiCloud')
    if (r === 'copied') toast('Address copied', 'ok')
    else if (r === 'failed') toast("Couldn't share or copy — long-press the link instead", 'err')
  }

  return (
    <div className="rp-cards stag">
      {rows.map((r) => (
        <div key={r.url} className="rp-card glass rp-reach-row">
          <div className="rp-reach-meta">
            <span className="rp-name">{r.label}</span>
            <a className="rp-reach-url" href={r.url} target="_blank" rel="noreferrer">
              {r.url}
            </a>
          </div>
          <div className="rp-reach-actions">
            <button
              className="btn iconbtn"
              aria-label={'Copy the ' + r.label + ' address'}
              title="Copy"
              onClick={() => copy(r.url)}
            >
              <Icon name="copy" size={15} />
            </button>
            <button
              className="btn iconbtn"
              aria-label={'Share the ' + r.label + ' address'}
              title="Share"
              onClick={() => share(r.url)}
            >
              <Icon name="share" size={15} />
            </button>
          </div>
        </div>
      ))}

      {!settled && rows.length === 0 && (
        <div className="rp-card glass" aria-hidden="true">
          <div className="skeleton rp-sk-line" style={{ width: 200 }} />
        </div>
      )}

      {settled && rows.length === 0 && (
        <div className="empty">
          <div className="btn iconbtn" aria-hidden="true">
            <Icon name="wifi" size={22} />
          </div>
          No addresses yet — your cloud is only on this phone's screen until you connect it to the
          network.
        </div>
      )}

      <div className="muted rp-note">Away from home? Turn on the tunnel — Host → Tools.</div>
    </div>
  )
}

export default function RemotePanel({ onGoTo }) {
  return (
    <div className="rp-panel">
      <div className="rp-toolbar">
        <div>
          <div className="rp-title">Remote</div>
          <div className="rp-subtitle muted">How other devices reach this cloud, and how your laptop joins it</div>
        </div>
      </div>

      <p className="rp-story muted">
        Remote is how other devices reach this cloud, and how you bring your laptop's project here.
      </p>

      <section className="rp-step-block">
        <div className="rp-step-head">
          <span className="rp-step-no">1</span>
          <span className="rp-name">See this cloud from another device</span>
        </div>
        <p className="muted rp-note">Same Wi-Fi only, unless the tunnel is on.</p>
        <Reach />
      </section>

      <section className="rp-step-block">
        <div className="rp-step-head">
          <span className="rp-step-no">2</span>
          <span className="rp-name">Bring your laptop's project here</span>
        </div>
        <ProjectMemory />
      </section>

      <section className="rp-step-block">
        <div className="rp-step-head">
          <span className="rp-step-no">3</span>
          <span className="rp-name">Use ZCode from this phone</span>
        </div>
        <p className="muted rp-note">
          ZCode has its own phone feature, called Mobile remote control. MittiCloud does not connect to ZCode.
        </p>
        <button className="btn btn-primary" onClick={() => onGoTo && onGoTo('guides')}>
          Open the full ZCode guide
        </button>
      </section>
    </div>
  )
}
