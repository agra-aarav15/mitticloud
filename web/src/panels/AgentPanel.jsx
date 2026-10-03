import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../icons.jsx'
import { toast } from '../api.js'
import {
  fetchAgentProviders,
  fetchAgentSessions,
  fetchAgentSession,
  createAgentSession,
  sendAgentMessage,
  deleteAgentSession,
  fetchAgentWorkspaces,
  saveAgentKey,
  fetchHostLan
} from '../api.js'
import './AgentPanel.css'

function ToolChip({ m }) {
  const label = m.name === 'run_command' ? 'command' : m.name.replace(/_/g, ' ')
  return (
    <details className="toolchip">
      <summary>
        <span className={'toolname' + (m.ok === false ? ' failed' : '')}>{label}</span>
        <span className="muted">{m.ok === false ? 'failed' : 'ran'}</span>
      </summary>
      <pre>{m.text}</pre>
    </details>
  )
}

function Typing() {
  return (
    <div className="msg agent typing" aria-label="The agent is working">
      <span className="dot" />
      <span className="dot" />
      <span className="dot" />
      <span className="typing-label">working — files and commands run for real</span>
    </div>
  )
}

export default function AgentPanel() {
  const [providers, setProviders] = useState([])
  const [sessions, setSessions] = useState([])
  const [workspaces, setWorkspaces] = useState([])
  const [lanUrls, setLanUrls] = useState([])
  const [activeId, setActiveId] = useState(null)
  const [active, setActive] = useState(null)
  const [setupOpen, setSetupOpen] = useState(false)
  const [newProvider, setNewProvider] = useState('gemini')
  const [newModel, setNewModel] = useState('')
  const [newEndpoint, setNewEndpoint] = useState('')
  const [newWorkspace, setNewWorkspace] = useState('.')
  const [keyDraft, setKeyDraft] = useState('')
  const [text, setText] = useState('')
  const [gate, setGate] = useState(null)
  const [busy, setBusy] = useState(false)
  const threadRef = useRef(null)

  const refreshProviders = useCallback(
    () => fetchAgentProviders().then((d) => setProviders(d.providers)).catch(() => {}),
    []
  )
  const refreshSessions = useCallback(
    () => fetchAgentSessions().then(setSessions).catch(() => {}),
    []
  )

  const loadActive = useCallback((id) => {
    if (!id) return
    fetchAgentSession(id).then(setActive).catch(() => {})
  }, [])

  useEffect(() => {
    refreshProviders()
    refreshSessions()
    fetchAgentWorkspaces().then(setWorkspaces).catch(() => {})
    fetchHostLan().then((d) => setLanUrls(d.urls || [])).catch(() => {})
  }, [refreshProviders, refreshSessions])

  // poll while the agent is working so every tool step appears live
  const running = active && active.running
  useEffect(() => {
    if (!activeId || !running) return
    const t = setInterval(() => {
      loadActive(activeId)
      refreshSessions()
    }, 1400)
    return () => clearInterval(t)
  }, [activeId, running, loadActive, refreshSessions])

  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [active && active.messages.length, running])

  const providerById = (id) => providers.find((p) => p.id === id)

  function openSession(id) {
    setActiveId(id)
    setSetupOpen(false)
    setGate(null)
    loadActive(id)
  }

  async function createSession() {
    setBusy(true)
    try {
      const s = await createAgentSession({
        providerId: newProvider,
        model: newModel.trim() || undefined,
        endpoint: newEndpoint.trim() || undefined,
        workspace: newWorkspace
      })
      setSetupOpen(false)
      setNewModel('')
      setNewEndpoint('')
      setKeyDraft('')
      setActiveId(s.id)
      setActive(s)
      refreshSessions()
    } catch (err) {
      toast(err.message, 'err')
    } finally {
      setBusy(false)
    }
  }

  async function saveKey() {
    setBusy(true)
    try {
      await saveAgentKey(newProvider, keyDraft)
      toast('Key saved on this device — it never leaves the server', 'ok')
      setKeyDraft('')
      refreshProviders()
    } catch (err) {
      toast(err.message, 'err')
    } finally {
      setBusy(false)
    }
  }

  async function send(force = false) {
    const t = text.trim()
    if (!t || !activeId) return
    setBusy(true)
    try {
      const out = await sendAgentMessage(activeId, t, force)
      if (out.batteryMode) {
        setGate(out)
      } else {
        setGate(null)
        setText('')
        loadActive(activeId)
        refreshSessions()
      }
    } catch (err) {
      toast(err.message, 'err')
    } finally {
      setBusy(false)
    }
  }

  async function removeSession(id) {
    try {
      await deleteAgentSession(id)
      if (id === activeId) {
        setActiveId(null)
        setActive(null)
      }
      refreshSessions()
    } catch (err) {
      toast(err.message, 'err')
    }
  }

  const sel = providerById(newProvider)
  const showSetup = setupOpen || !activeId
  const messages = (active && active.messages) || []

  return (
    <div className="agent">
      <aside className="agent-side glass">
        <button
          className="btn btn-primary ag-new"
          onClick={() => {
            setSetupOpen(true)
            setActiveId(null)
            setActive(null)
          }}
        >
          <Icon name="plus" size={16} /> New session
        </button>
        <div className="ag-label">Sessions</div>
        <div className="ag-list">
          {sessions.length === 0 && <div className="ag-none muted">No sessions yet</div>}
          {sessions.map((s) => (
            <button
              key={s.id}
              className={'ag-item' + (s.id === activeId ? ' active' : '')}
              onClick={() => openSession(s.id)}
            >
              <span className="ag-title">{s.title}</span>
              <span className="ag-meta">
                {s.providerId}
                {s.running ? ' · working' : ''}
              </span>
              <button
                className="ag-del"
                aria-label="Delete session"
                onClick={(e) => {
                  e.stopPropagation()
                  removeSession(s.id)
                }}
              >
                <Icon name="trash" size={13} />
              </button>
            </button>
          ))}
        </div>
        <div className="ag-247">
          <Icon name="bot" size={14} />
          <span>
            Runs 24/7 on this device. Open it from any browser:
            {lanUrls[0] ? <code>{lanUrls[0]}</code> : <code>http://&lt;lan-ip&gt;:7333</code>}
          </span>
        </div>
      </aside>

      <section className="agent-main glass">
        {showSetup ? (
          <div className="ag-setup">
            <h2>Start an agent session</h2>
            <p className="muted">
              Pick a brain (paste its free API key — stored only on this device) and a
              workspace folder. The agent reads, writes and runs real commands inside that
              folder.
            </p>
            <div className="ag-provs">
              {providers.map((p) => (
                <button
                  key={p.id}
                  className={'ag-prov' + (newProvider === p.id ? ' active' : '')}
                  onClick={() => setNewProvider(p.id)}
                >
                  <span className="ag-prov-name">{p.label}</span>
                  <span className="ag-prov-key">{p.hasKey ? 'key saved' : 'needs key'}</span>
                </button>
              ))}
            </div>
            {sel && (
              <div className="ag-free muted">
                {sel.freeNote}
                {sel.keyUrl && (
                  <>
                    {' '}
                    <a href={sel.keyUrl} target="_blank" rel="noreferrer">
                      get a key
                    </a>
                  </>
                )}
              </div>
            )}
            {sel && (
              <div className="ag-keyrow">
                <input
                  type="password"
                  autoComplete="off"
                  placeholder={
                    sel.hasKey
                      ? 'A key is saved — paste a new one to replace it'
                      : 'Paste your ' + sel.label + ' API key'
                  }
                  value={keyDraft}
                  onChange={(e) => setKeyDraft(e.target.value)}
                />
                <button className="btn" disabled={busy || !keyDraft.trim()} onClick={saveKey}>
                  {sel.hasKey ? 'Replace key' : 'Save key'}
                </button>
              </div>
            )}
            {sel && sel.id === 'custom' && (
              <div className="ag-keyrow">
                <input
                  placeholder="Base URL, e.g. http://127.0.0.1:8080/v1"
                  value={newEndpoint}
                  onChange={(e) => setNewEndpoint(e.target.value)}
                />
                <input
                  placeholder="Model name"
                  value={newModel}
                  onChange={(e) => setNewModel(e.target.value)}
                />
              </div>
            )}
            <div className="ag-keyrow">
              <select value={newWorkspace} onChange={(e) => setNewWorkspace(e.target.value)}>
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    Workspace: {w.label}
                  </option>
                ))}
              </select>
            </div>
            <button className="btn btn-primary" disabled={busy} onClick={createSession}>
              Start session
            </button>
          </div>
        ) : (
          <>
            <header className="ag-head">
              <div>
                <div className="ag-head-title">{active ? active.title : 'Session'}</div>
                <div className="ag-head-meta muted">
                  {active && active.providerId}
                  {active && active.model ? ' · ' + active.model : ''} · workspace:{' '}
                  {active && active.workspace === '.' ? 'vault root' : active && active.workspace}
                </div>
              </div>
            </header>

            {gate && (
              <div className="banner ag-gate">
                <Icon name="alert" size={16} />
                <span>{gate.message}</span>
                <button className="btn" onClick={() => send(true)}>
                  Run anyway
                </button>
                <button className="iconbtn" aria-label="Dismiss" onClick={() => setGate(null)}>
                  <Icon name="x" size={14} />
                </button>
              </div>
            )}

            <div className="thread" ref={threadRef}>
              {messages.length === 0 && (
                <div className="empty">
                  <div className="iconbtn">
                    <Icon name="bot" size={22} />
                  </div>
                  Give the agent a job. It can list and edit files in the workspace and run
                  real commands — builds, scripts, git, anything a terminal can do.
                </div>
              )}
              {messages.map((m, i) => {
                if (m.role === 'user')
                  return (
                    <div key={i} className="msg user">
                      {m.text}
                    </div>
                  )
                if (m.role === 'tool') return <ToolChip key={i} m={m} />
                return (
                  <div key={i} className={'msg agent' + (m.error ? ' err' : '')}>
                    {m.text}
                  </div>
                )
              })}
              {running && <Typing />}
            </div>

            <div className="composer">
              <textarea
                rows={1}
                placeholder={
                  active && active.running
                    ? 'The agent is working…'
                    : 'Tell the agent what to do'
                }
                value={text}
                disabled={busy || (active && active.running)}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    send()
                  }
                }}
              />
              <button
                className="btn btn-primary"
                disabled={busy || !text.trim() || (active && active.running)}
                onClick={() => send()}
                aria-label="Send"
              >
                <Icon name="arrowRight" size={16} />
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  )
}
