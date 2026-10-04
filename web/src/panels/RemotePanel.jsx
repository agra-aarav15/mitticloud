import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../icons.jsx'
import { toast, timeAgo, humanizeBytes, tokenHeaders } from '../api.js'
import AgentPanel from './AgentPanel.jsx'
import './RemotePanel.css'

// Remote — everything that works while you're away from the desk, in one tab:
//   · This phone's agent  (the 24/7 agent with real hands, built into MittiCloud)
//   · Laptop · ZCode      (ZCode's own Web Remote Control, one tap from the phone)
//   · Project memory      (project files + coding-agent context stored on the phone,
//                          resumable from any device — the mitti-bridge CLI uses this)

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

// --- laptop · ZCode remote control ---

function ZcodeRemote() {
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
    <div className="rp-zcode">
      <p className="rp-story muted">
        ZCode on your laptop has a built-in <b>Web Remote Control</b>. Start it there, and ZCode's
        official web client shows your session — chat, workspace, tasks — on this phone through
        their own secure relay. MittiCloud keeps it one tap away.
      </p>
      <ol className="rp-steps muted">
        <li>Open ZCode on your laptop.</li>
        <li>Start the Remote option (Web Remote Control).</li>
        <li>Copy the link it shows and paste it below.</li>
      </ol>
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
          />
          <button className="btn btn-primary" disabled={!draft.trim()} onClick={save}>
            Save
          </button>
        </div>
      )}
    </div>
  )
}

// --- project memory (the bridge, in plain words) ---

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
      setResumed(text)
      await navigator.clipboard.writeText(text).catch(() => {})
      toast('Copied — paste it into your agent', 'ok')
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
        sessions.map((s) => (
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
              <button className="btn" disabled={busy} onClick={() => doNewChat(s)}>
                <Icon name="file" size={14} /> New chat
              </button>
            </div>
            {resumed && (
              <pre className="rp-pre">{resumed}</pre>
            )}
          </section>
        ))
      )}
    </div>
  )
}

const SEGMENTS = [
  { id: 'zcode', label: 'Laptop · ZCode' },
  { id: 'phone', label: "This phone's agent" },
  { id: 'memory', label: 'Project memory' }
]

export default function RemotePanel() {
  const [seg, setSeg] = useState(() => {
    try {
      const s = localStorage.getItem(SEG_KEY)
      return SEGMENTS.some((x) => x.id === s) ? s : 'zcode'
    } catch {
      return 'zcode'
    }
  })

  const pick = (id) => {
    setSeg(id)
    try {
      localStorage.setItem(SEG_KEY, id)
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="rp-panel">
      <div className="rp-toolbar">
        <div>
          <div className="rp-title">Remote</div>
          <div className="rp-subtitle muted">Your agents and your work — from anywhere</div>
        </div>
      </div>

      <div className="rp-segments" role="tablist" aria-label="Remote sections">
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

      <div className="rp-body">
        {seg === 'phone' && <AgentPanel />}
        {seg === 'zcode' && <ZcodeRemote />}
        {seg === 'memory' && <ProjectMemory />}
      </div>
    </div>
  )
}
