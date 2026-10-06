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
  fetchTunnel,
  fetchClientKeys,
  createClientKey,
  revokeClientKey
} from '../api.js'
import './RemotePanel.css'

// Remote — the connect hub: every way OTHER apps and devices reach this cloud.
//   · Apps     MCP for AI apps, per-app API keys, the ZCode web remote, SSH
//   · Devices  project memory + pairing a laptop (the mitti-bridge flow)
//   · Reach    the real addresses this cloud answers on (tailnet, tunnel, LAN)
// The agent chat lives in its own Agent tab now — Remote points at it, it
// doesn't embed it.

const SEG_KEY = 'mitti_remote_seg'
const ZCODE_KEY = 'mitti_zcode_remote'
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

// one copyable code row + a copy button that tells the truth
function CodeRow({ text, wrap = false, label = 'Copy' }) {
  return (
    <div className={'rp-coderow' + (wrap ? ' wrap' : '')}>
      <code>{text}</code>
      <button
        className="btn iconbtn"
        aria-label={label}
        title={label}
        onClick={async () => {
          const ok = await copyText(text)
          toast(ok ? 'Copied' : "Couldn't copy — select it manually", ok ? 'ok' : 'info')
        }}
      >
        <Icon name="copy" size={14} />
      </button>
    </div>
  )
}

// --- APPS · card 1: MCP, the door for AI apps ---

function McpCard() {
  const base = window.location.origin
  const cmd = 'node <absolute-or-repo>/scripts/mitti-mcp.mjs'
  // placeholders only — a real key never appears in UI text, ever
  const config = JSON.stringify(
    {
      mcpServers: {
        mitticloud: {
          command: 'node',
          args: ['<absolute-or-repo>/scripts/mitti-mcp.mjs'],
          env: { MITTI_URL: "<this cloud's address>", MITTI_KEY: 'mitti_...' }
        }
      }
    },
    null,
    2
  )
  return (
    <section className="rp-card glass">
      <div className="rp-card-title">
        <span className="rp-name">MCP — AI apps connect here</span>
        <span className="muted rp-sub">
          Give ZCode, Claude, Cursor — any MCP app — real tools for this cloud: files, photos,
          sites, live apps, status.
        </span>
      </div>
      <ol className="rp-steps">
        <li>
          <div className="rp-step-title">Create a key</div>
          <div className="muted rp-step-note">One per app — make it in the API keys card just below.</div>
        </li>
        <li>
          <div className="rp-step-title">Point your app at this command</div>
          <CodeRow text={cmd} label="Copy the command" />
          <div className="muted rp-step-note">{'with env MITTI_URL=<base url> and MITTI_KEY=<your key>'}</div>
        </li>
        <li>
          <div className="rp-step-title">On this network the cloud is at</div>
          <CodeRow text={base} label="Copy this cloud's address" />
        </li>
      </ol>
      <details className="rp-advanced">
        <summary>Advanced</summary>
        <div className="rp-advanced-body">
          <CodeRow text={config} wrap label="Copy the MCP config" />
          <div className="muted rp-step-note">
            Remote HTTP clients: POST {base}/mcp with header Authorization: Bearer mitti_… —
            JSON-RPC 2.0, tools/list and tools/call.
          </div>
        </div>
      </details>
    </section>
  )
}

// --- APPS · card 2: per-app API keys ---

function ApiKeysCard() {
  const [keys, setKeys] = useState(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState(null) // { key, name } — shown ONCE
  const [confirmId, setConfirmId] = useState(null)
  const alive = useRef(true)

  const load = useCallback(() => {
    fetchClientKeys()
      .then((k) => alive.current && setKeys(k))
      .catch(() => alive.current && setKeys([]))
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
      toast('Give the key a name — which app is it for?', 'info')
      return
    }
    setBusy(true)
    try {
      const d = await createClientKey(n)
      setCreated({ key: d.key, name: (d.record && d.record.name) || n })
      setName('')
      load()
    } catch (err) {
      toast(err.message, 'err')
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (k) => {
    if (confirmId !== k.id) {
      setConfirmId(k.id)
      setTimeout(() => alive.current && setConfirmId((c) => (c === k.id ? null : c)), 3000)
      return
    }
    try {
      await revokeClientKey(k.id)
      toast('Key revoked — that app can no longer connect', 'ok')
      setConfirmId(null)
      load()
    } catch (err) {
      toast(err.message, 'err')
    }
  }

  return (
    <section className="rp-card glass">
      <div className="rp-card-title">
        <span className="rp-name">API keys</span>
        <span className="muted rp-sub">
          One key per app — revoke anytime. The full key is shown once, at creation.
        </span>
      </div>

      {created && (
        <div className="rp-reveal">
          <div className="rp-reveal-head">
            <Icon name="alert" size={14} />
            <span>Copy it now — this is the only time the full key is shown.</span>
          </div>
          <div className="rp-coderow">
            <code>{created.key}</code>
            <button
              className="btn iconbtn"
              aria-label="Copy the key"
              title="Copy"
              onClick={async () => {
                const ok = await copyText(created.key)
                toast(
                  ok ? 'Key copied — paste it into your app now' : "Couldn't copy — select the key manually",
                  ok ? 'ok' : 'info'
                )
              }}
            >
              <Icon name="copy" size={14} />
            </button>
            <button className="btn" onClick={() => setCreated(null)}>
              Done
            </button>
          </div>
        </div>
      )}

      {keys !== null && keys.length > 0 && (
        <div className="rp-keylist">
          {keys.map((k) => (
            <div key={k.id} className="rp-keyrow">
              <div className="rp-keymeta">
                <span className="rp-keyname">{k.name}</span>
                <span className="muted rp-keysub">
                  created {timeAgo(k.createdAt)} · {k.lastUsed ? 'used ' + timeAgo(k.lastUsed) : 'never used'}
                </span>
              </div>
              {confirmId === k.id ? (
                <button className="btn btn-danger" onClick={() => revoke(k)}>
                  Sure?
                </button>
              ) : (
                <button className="btn" onClick={() => revoke(k)}>
                  Revoke
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="rp-actions">
        <input
          placeholder="Which app is this for?"
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') create()
          }}
        />
        <button className="btn btn-primary" disabled={busy} onClick={create}>
          <Icon name="plus" size={15} /> Create
        </button>
      </div>
    </section>
  )
}

// --- APPS · card 3: the ZCode web remote ---

function ZcodeCard() {
  const [saved, setSaved] = useState(() => {
    try {
      return localStorage.getItem(ZCODE_KEY) || ''
    } catch {
      return ''
    }
  })
  const [draft, setDraft] = useState('')

  const save = () => {
    const t = draft.trim()
    if (!t) return
    if (!/^https?:\/\//i.test(t)) {
      toast('That does not look like a ZCode link — it should start with http', 'err')
      return
    }
    try {
      localStorage.setItem(ZCODE_KEY, t)
    } catch {
      /* private mode */
    }
    setSaved(t)
    setDraft('')
    toast('Saved — ZCode remote is one tap away', 'ok')
  }

  const forget = () => {
    try {
      localStorage.removeItem(ZCODE_KEY)
    } catch {
      /* ignore */
    }
    setSaved('')
  }

  return (
    <section className="rp-card glass">
      <div className="rp-card-title">
        <span className="rp-name">ZCode remote</span>
        <span className="muted rp-sub">
          ZCode's built-in Web Remote Control — paste the link your laptop's ZCode shows.
        </span>
      </div>
      {saved ? (
        <>
          <div className="rp-saved">
            <span className="chip chip-ok">Paired</span>
            <span className="rp-saved-url muted">{saved}</span>
          </div>
          <div className="rp-actions">
            <a className="btn btn-primary rp-open" href={saved} target="_blank" rel="noreferrer">
              <Icon name="bolt" size={15} /> Open remote
            </a>
            <button className="btn" onClick={forget}>
              Forget this link
            </button>
          </div>
        </>
      ) : (
        <div className="rp-actions">
          <input
            placeholder="Paste the ZCode remote link or code"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
            }}
          />
          <button className="btn btn-primary" disabled={!draft.trim()} onClick={save}>
            Save
          </button>
        </div>
      )}
    </section>
  )
}

// --- APPS · card 4: a real shell over Termux's ssh ---

function SshCard() {
  const [ip, setIp] = useState(null)
  useEffect(() => {
    let alive = true
    fetchHostLan()
      .then((d) => {
        if (!alive) return
        const u = (d.urls || [])[0]
        try {
          setIp(u ? new URL(u).hostname : null)
        } catch {
          setIp(null)
        }
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  return (
    <section className="rp-card glass">
      <div className="rp-card-title">
        <span className="rp-name">SSH — a real shell</span>
        <span className="muted rp-sub">
          Termux's own ssh server — the UI stays in your browser, this is the terminal.
        </span>
      </div>
      <div className="rp-ssh-label muted">On the phone (Termux)</div>
      <CodeRow text="pkg install openssh -y && passwd && sshd" label="Copy the Termux setup command" />
      <div className="rp-ssh-label muted">From a laptop</div>
      <CodeRow text={'ssh -p 8022 <user>@' + (ip || '<ip>')} label="Copy the ssh command" />
      <div className="muted rp-note">The password is the one you set with passwd.</div>
    </section>
  )
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

const SEGMENTS = [
  { id: 'apps', label: 'Apps' },
  { id: 'devices', label: 'Devices' },
  { id: 'reach', label: 'Reach' }
]
// v0.13 segments had the agent embedded — migrate the saved pick to the new map
const SEG_LEGACY = { phone: 'reach', zcode: 'apps', memory: 'devices' }

export default function RemotePanel() {
  const [seg, setSeg] = useState(() => {
    try {
      const s = localStorage.getItem(SEG_KEY)
      if (s && SEG_LEGACY[s]) return SEG_LEGACY[s]
      if (SEGMENTS.some((x) => x.id === s)) return s
    } catch {
      /* private mode */
    }
    return 'apps'
  })

  const pick = (id) => {
    setSeg(id)
    try {
      localStorage.setItem(SEG_KEY, id)
    } catch {
      /* ignore */
    }
  }

  const segIndex = Math.max(
    0,
    SEGMENTS.findIndex((s) => s.id === seg)
  )

  return (
    <div className="rp-panel">
      <div className="rp-toolbar">
        <div>
          <div className="rp-title">Remote</div>
          <div className="rp-subtitle muted">Every way other apps and devices reach this cloud</div>
        </div>
      </div>

      <div className="rp-segments" role="tablist" aria-label="Remote sections">
        <span className="rp-thumb" style={{ '--seg-i': segIndex }} aria-hidden="true" />
        {SEGMENTS.map((s) => (
          <button
            key={s.id}
            role="tab"
            aria-selected={seg === s.id}
            className={'rp-seg' + (seg === s.id ? ' active' : '')}
            onClick={() => pick(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="rp-body" key={seg}>
        {seg === 'apps' && (
          <div className="rp-cards stag">
            <McpCard />
            <ApiKeysCard />
            <ZcodeCard />
            <SshCard />
          </div>
        )}
        {seg === 'devices' && <ProjectMemory />}
        {seg === 'reach' && <Reach />}
      </div>
    </div>
  )
}
