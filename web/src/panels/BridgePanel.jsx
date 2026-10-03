import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../icons.jsx'
import { toast, timeAgo, humanizeBytes } from '../api.js'
import './BridgePanel.css'

const POLL_MS = 30000
const MAX_FILE_BYTES = 5 * 1024 * 1024 // server rejects bigger files
const MAX_BATCH_FILES = 25 // server caps a request at 50 MB of files
const MAX_BATCH_BYTES = 40 * 1024 * 1024

const BRIDGE = '/api/bridge/sessions'

// api.js does not export a bridge client and must not be modified, so the
// bridge calls live here, same fetch/j pattern as api.js.
async function req(path, opts = {}) {
  const res = await fetch(BRIDGE + path, opts)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status })
  return data
}

const postJson = (method, body) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
})

const listSessions = () => req('').then((d) => d.sessions || [])
const createSession = (name) => req('', postJson('POST', { name }))
const deleteSession = (id) => req('/' + encodeURIComponent(id), { method: 'DELETE' })
const startNewChat = (id) => req('/' + encodeURIComponent(id) + '/new-chat', postJson('POST', {}))
const uploadFiles = (id, files) =>
  req('/' + encodeURIComponent(id) + '/files', postJson('POST', { files }))
const fetchChat = (id) => req('/' + encodeURIComponent(id) + '/chat').then((d) => d.messages || [])

// The context comes back as raw text; 404 simply means nothing saved yet.
async function fetchContext(id) {
  const res = await fetch(BRIDGE + '/' + encodeURIComponent(id) + '/context')
  if (res.status === 404) return null
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw Object.assign(new Error(data.error || res.statusText), { status: res.status })
  }
  return res.text()
}

// Binary-safe base64 for any file type.
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      resolve(url.slice(url.indexOf(',') + 1))
    }
    reader.onerror = () => reject(new Error('Could not read ' + file.name))
    reader.readAsDataURL(file)
  })
}

// Keep the relative path but drop the picked top folder.
function relPathOf(file) {
  const full = file.webkitRelativePath || ''
  const parts = full.split('/').filter(Boolean)
  if (parts.length > 1) return parts.slice(1).join('/')
  if (parts.length === 1) return parts[0]
  return file.name || ''
}

export default function BridgePanel() {
  const [sessions, setSessions] = useState(null) // null = loading
  const [selectedId, setSelectedId] = useState(null)
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(null) // 'resume' | 'newchat' | 'upload' | 'delete'
  const [confirmId, setConfirmId] = useState(null) // two-step delete
  const [uploadProgress, setUploadProgress] = useState(null) // {done, total}
  const [resumeView, setResumeView] = useState(null) // transcript text
  const mountedRef = useRef(true)

  const load = useCallback(async () => {
    try {
      const list = await listSessions()
      if (mountedRef.current) setSessions(list)
    } catch {
      if (mountedRef.current) setSessions([])
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    load()
    const timer = setInterval(load, POLL_MS)
    return () => {
      mountedRef.current = false
      clearInterval(timer)
    }
  }, [load])

  const selected = (sessions || []).find((s) => s.id === selectedId) || null

  const toggleSelect = (id) => {
    setSelectedId((cur) => (cur === id ? null : id))
    setConfirmId(null)
    setResumeView(null)
    setUploadProgress(null)
  }

  const submitCreate = async (e) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) {
      toast('Give the session a name first', 'info')
      return
    }
    setCreating(true)
    try {
      const s = await createSession(trimmed)
      toast('Session created', 'ok')
      setName('')
      setSelectedId(s.id)
      await load()
    } catch (err) {
      toast(err.message || 'Could not create the session', 'err')
    } finally {
      if (mountedRef.current) setCreating(false)
    }
  }

  const doResume = async () => {
    if (!selected) return
    setBusy('resume')
    try {
      const [context, messages] = await Promise.all([fetchContext(selected.id), fetchChat(selected.id)])
      const parts = []
      parts.push(context != null ? context.trimEnd() : '(no context saved for this session)')
      parts.push('')
      if (messages.length) {
        parts.push('--- chat (' + messages.length + ' messages) ---')
        for (const m of messages) parts.push('[' + m.role + '] ' + m.text)
      } else {
        parts.push('(no chat messages)')
      }
      if (mountedRef.current) setResumeView(parts.join('\n'))
    } catch (err) {
      toast(err.message || 'Could not load the session', 'err')
    } finally {
      if (mountedRef.current) setBusy(null)
    }
  }

  const copyResume = async () => {
    if (!resumeView) return
    try {
      await navigator.clipboard.writeText(resumeView)
      toast('Copied — paste it into your agent', 'ok')
    } catch {
      toast('Could not copy', 'err')
    }
  }

  const doNewChat = async () => {
    if (!selected) return
    if (!window.confirm('Start a new chat for "' + selected.name + '"? Context is kept, chat messages are cleared.'))
      return
    setBusy('newchat')
    try {
      await startNewChat(selected.id)
      toast('New chat started — context kept', 'ok')
      setResumeView(null)
      await load()
    } catch (err) {
      toast(err.message || 'Could not start a new chat', 'err')
    } finally {
      if (mountedRef.current) setBusy(null)
    }
  }

  const onFolderPick = async (e) => {
    const pickedFiles = Array.from(e.target.files || [])
    e.target.value = '' // allow picking the same folder again
    if (!selected || !pickedFiles.length) return

    const skipped = []
    const items = []
    for (const f of pickedFiles) {
      const rel = relPathOf(f)
      if (!rel) continue
      if (f.size > MAX_FILE_BYTES) {
        skipped.push(f.name)
        continue
      }
      items.push({ file: f, rel })
    }
    items.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
    if (!items.length) {
      toast('No files to upload', 'info')
      return
    }

    setBusy('upload')
    setUploadProgress({ done: 0, total: items.length })
    try {
      let batch = []
      let batchBytes = 0
      let done = 0
      const flush = async () => {
        if (!batch.length) return
        const payload = []
        for (const item of batch) {
          payload.push({ path: item.rel, contentBase64: await fileToBase64(item.file) })
        }
        await uploadFiles(selected.id, payload)
        done += batch.length
        batch = []
        batchBytes = 0
        if (mountedRef.current) setUploadProgress({ done, total: items.length })
      }
      for (const item of items) {
        if (batch.length >= MAX_BATCH_FILES || batchBytes + item.file.size > MAX_BATCH_BYTES) {
          await flush()
        }
        batch.push(item)
        batchBytes += item.file.size
      }
      await flush()
      toast('Uploaded ' + done + ' file' + (done === 1 ? '' : 's') + ' to ' + selected.name, 'ok')
      if (skipped.length) toast('Skipped ' + skipped.length + ' file(s) over 5 MB', 'info')
      await load()
    } catch (err) {
      toast(err.message || 'Upload failed', 'err')
    } finally {
      if (mountedRef.current) {
        setBusy(null)
        setUploadProgress(null)
      }
    }
  }

  const doDelete = async (s) => {
    if (confirmId !== s.id) {
      setConfirmId(s.id)
      return
    }
    setBusy('delete')
    try {
      await deleteSession(s.id)
      toast('Session deleted', 'ok')
      setConfirmId(null)
      if (selectedId === s.id) {
        setSelectedId(null)
        setResumeView(null)
      }
      await load()
    } catch (err) {
      toast(err.message || 'Could not delete the session', 'err')
    } finally {
      if (mountedRef.current) setBusy(null)
    }
  }

  return (
    <div className="br-panel">
      <div className="br-toolbar">
        <div>
          <div className="br-title">Bridge</div>
          <div className="br-subtitle muted">Coding-agent context, chat and files — stored here, resumed anywhere</div>
        </div>
        <form className="br-create" onSubmit={submitCreate}>
          <input
            className="br-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Session name"
            aria-label="Session name"
            maxLength={120}
            disabled={creating}
          />
          <button type="submit" className="btn btn-primary" disabled={creating || !name.trim()}>
            <Icon name="plus" size={15} />
            Create
          </button>
        </form>
      </div>

      {sessions === null ? (
        <div className="br-card glass" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton" style={{ height: 14, width: i === 0 ? 180 : 130 }} />
          ))}
        </div>
      ) : sessions.length === 0 ? (
        <div className="empty">
          <div className="btn iconbtn" aria-hidden="true">
            <Icon name="cloud" size={22} />
          </div>
          Your coding agent&apos;s brain, stored on this phone. Continue any session from any device.
        </div>
      ) : (
        sessions.map((s) => {
          const open = s.id === selectedId
          return (
            <section key={s.id} className={'br-card glass' + (open ? ' is-open' : '')}>
              <div className="br-card-head">
                <button
                  type="button"
                  className="br-card-toggle"
                  onClick={() => toggleSelect(s.id)}
                  aria-expanded={open}
                >
                  <span className="br-card-title">
                    <span className="br-name">{s.name}</span>
                    <span className="chip br-id">{s.id}</span>
                  </span>
                  <span className="br-meta muted">
                    {humanizeBytes(s.contextBytes)} context · {s.chatCount} chats · {s.fileCount} files ·{' '}
                    {timeAgo(s.updatedAt)}
                  </span>
                  <Icon name="chevronUp" size={14} className={'br-chevron' + (open ? '' : ' is-flip')} />
                </button>
                {confirmId === s.id ? (
                  <button className="btn btn-danger br-delbtn" onClick={() => doDelete(s)} disabled={busy !== null}>
                    <Icon name="trash" size={14} />
                    Confirm delete
                  </button>
                ) : (
                  <button
                    className="btn iconbtn btn-danger"
                    onClick={() => doDelete(s)}
                    disabled={busy !== null}
                    aria-label={'Delete ' + s.name}
                    title="Delete"
                  >
                    <Icon name="trash" size={15} />
                  </button>
                )}
              </div>

              {open && (
                <div className="br-body">
                  <div className="br-actions">
                    <button
                      className="btn"
                      onClick={doResume}
                      disabled={busy !== null}
                      title="Load context + chat to copy into your agent"
                    >
                      <Icon name="refresh" size={14} />
                      Resume
                    </button>
                    <button
                      className="btn"
                      onClick={doNewChat}
                      disabled={busy !== null}
                      title="Keep the context, clear the chat"
                    >
                      <Icon name="file" size={14} />
                      New chat
                    </button>
                    <label className="btn br-upload" title="Upload a folder of project files">
                      <Icon name="upload" size={14} />
                      Upload folder
                      <input
                        type="file"
                        className="br-file"
                        webkitdirectory=""
                        multiple
                        onChange={onFolderPick}
                        disabled={busy !== null}
                        aria-label="Upload folder to this session"
                      />
                    </label>
                  </div>

                  {uploadProgress && (
                    <div className="br-progress muted">
                      Uploading {uploadProgress.done}/{uploadProgress.total}
                    </div>
                  )}
                  {busy === 'resume' && !resumeView && (
                    <div className="br-progress muted">Loading context and chat...</div>
                  )}

                  {resumeView && (
                    <div className="br-resume">
                      <div className="br-resume-head">
                        <span className="muted">Context + chat transcript</span>
                        <button className="btn br-copy" onClick={copyResume} disabled={busy !== null}>
                          <Icon name="check" size={14} />
                          Copy
                        </button>
                      </div>
                      <pre className="br-pre">{resumeView}</pre>
                    </div>
                  )}
                </div>
              )}
            </section>
          )
        })
      )}
    </div>
  )
}
