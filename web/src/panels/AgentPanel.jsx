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
  fetchHostLan,
  fetchCliStatus,
  installCliPreset
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

function Typing({ isCli }) {
  return (
    <div className="msg agent typing" aria-label="The agent is working">
      <span className="dot" />
      <span className="dot" />
      <span className="dot" />
      <span className="typing-label">
        {isCli ? 'the CLI agent is working — real output follows' : 'working — files and commands run for real'}
      </span>
    </div>
  )
}

export default function AgentPanel() {
  const [providers, setProviders] = useState([])
  const [cliPresets, setCliPresets] = useState([])
  const [cliInstalling, setCliInstalling] = useState(null)
  const [sessions, setSessions] = useState([])
  const [workspaces, setWorkspaces] = useState([])
  const [lanUrls, setLanUrls] = useState([])
  const [activeId, setActiveId] = useState(null)
  const [active, setActive] = useState(null)
  const [setupOpen, setSetupOpen] = useState(false)
  // brain choice: 'cli' (real agent CLI on this device) or 'brain' (API model)
  const [engine, setEngine] = useState('cli')
  const [selectedCli, setSelectedCli] = useState('opencode')
  const [cliCmdDraft, setCliCmdDraft] = useState('')
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
  const refreshCli = useCallback(() => {
    fetchCliStatus()
      .then((d) => {
        setCliPresets(d.presets || [])
        setCliInstalling(d.installing || null)
      })
      .catch(() => {})
  }, [])

  const loadActive = useCallback((id) => {
    if (!id) return
    fetchAgentSession(id).then(setActive).catch(() => {})
  }, [])

  useEffect(() => {
    refreshProviders()
    refreshSessions()
    refreshCli()
    fetchAgentWorkspaces().then(setWorkspaces).catch(() => {})
    fetchHostLan().then((d) => setLanUrls(d.urls || [])).catch(() => {})
  }, [refreshProviders, refreshSessions, refreshCli])

  // poll while the agent is working so every line lands live
  const running = active && active.running
  useEffect(() => {
    if (!activeId || !running) return
    const t = setInterval(() => {
      loadActive(activeId)
      refreshSessions()
    }, 1400)
    return () => clearInterval(t)
  }, [activeId, running, loadActive, refreshSessions])

  // poll the installer while npm runs
  useEffect(() => {
    if (!cliInstalling) return
    const t = setInterval(refreshCli, 2000)
    return () => clearInterval(t)
  }, [cliInstalling, refreshCli])

  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [active && active.messages.length, running])

  const providerById = (id) => providers.find((p) => p.id === id)
  const cliById = (id) => cliPresets.find((p) => p.id === id)

  function openSession(id) {
    setActiveId(id)
    setSetupOpen(false)
    setGate(null)
    loadActive(id)
  }

  async function createSession() {
    setBusy(true)
    try {
      let payload
      if (engine === 'cli') {
        const preset = cliById(selectedCli)
        const cmd = (cliCmdDraft.trim() || (preset && preset.cmd) || '').trim()
        payload = {
          engine: 'cli',
          cliCmd: cmd,
          cliLabel: preset ? preset.label : 'Custom CLI',
          workspace: newWorkspace
        }
      } else {
        payload = {
          providerId: newProvider,
          model: newModel.trim() || undefined,
          endpoint: newEndpoint.trim() || undefined,
          workspace: newWorkspace
        }
      }
      const s = await createAgentSession(payload)
      setSetupOpen(false)
      setCliCmdDraft('')
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

  async function installCli() {
    try {
      await installCliPreset(selectedCli)
      toast('Installing — this can take a minute or two', 'info')
      refreshCli()
    } catch (err) {
      toast(err.message, 'err')
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
  const cli = cliById(selectedCli)
  const showSetup = setupOpen || !activeId
  const messages = (active && active.messages) || []
  const isCliSession = active && active.engine === 'cli'

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
                {s.engine === 'cli' ? (s.cliLabel || 'CLI') + ' · CLI' : s.providerId}
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
            <h2>Wake your agent</h2>
            <p className="muted">
              A real agent lives on this device. It reads, writes and runs commands inside the
              folder you pick — and you watch every line land.
            </p>

            <div className="ag-group-label muted">Real brains — CLI agents, running here</div>
            <div className="ag-provs">
              {cliPresets.map((p) => (
                <button
                  key={p.id}
                  className={'ag-prov' + (engine === 'cli' && selectedCli === p.id ? ' active' : '')}
                  onClick={() => {
                    setEngine('cli')
                    setSelectedCli(p.id)
                    setCliCmdDraft('')
                  }}
                >
                  <span className="ag-prov-name">{p.label}</span>
                  <span className={'ag-prov-key' + (p.installed ? ' ok' : '')}>
                    {p.id === 'custom'
                      ? 'your command'
                      : p.installed
                        ? 'installed'
                        : 'not installed'}
                  </span>
                </button>
              ))}
            </div>
            {engine === 'cli' && cli && (
              <div className="ag-tray">
                <div className="ag-free muted">{cli.note}</div>
                {cli.id !== 'custom' && !cli.installed && (
                  <div className="ag-keyrow">
                    <span className="muted ag-install-hint">{cli.install}</span>
                    <button
                      className="btn"
                      disabled={busy || Boolean(cliInstalling)}
                      onClick={installCli}
                    >
                      {cliInstalling && <span className="spin" aria-hidden="true" />}
                      {cliInstalling ? 'Installing…' : 'Install on this device'}
                    </button>
                  </div>
                )}
                {cliInstalling && cliInstalling.logTail && cliInstalling.logTail.length > 0 && (
                  <div className="muted ag-install-log">
                    {cliInstalling.logTail[cliInstalling.logTail.length - 1]}
                  </div>
                )}
                <div className="ag-keyrow">
                  <input
                    placeholder="Command — use {prompt} where the message goes"
                    value={cliCmdDraft || (cli.cmd || '')}
                    onChange={(e) => setCliCmdDraft(e.target.value)}
                  />
                </div>
              </div>
            )}

            <div className="ag-group-label muted">Chat brains — models with an API key</div>
            <div className="ag-provs">
              {providers.map((p) => (
                <button
                  key={p.id}
                  className={'ag-prov' + (engine === 'brain' && newProvider === p.id ? ' active' : '')}
                  onClick={() => {
                    setEngine('brain')
                    setNewProvider(p.id)
                  }}
                >
                  <span className="ag-prov-name">{p.label}</span>
                  <span className={'ag-prov-key' + (p.hasKey ? ' ok' : '')}>
                    {p.hasKey ? 'key saved' : 'needs key'}
                  </span>
                </button>
              ))}
            </div>
            {engine === 'brain' && sel && (
              <div className="ag-tray">
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
              </div>
            )}

            <div className="ag-startrow">
              <select value={newWorkspace} onChange={(e) => setNewWorkspace(e.target.value)}>
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    Workspace: {w.label}
                  </option>
                ))}
              </select>
              <button className="btn btn-primary" disabled={busy} onClick={createSession}>
                {busy && <span className="spin" aria-hidden="true" />}
                Start session
              </button>
            </div>
          </div>
        ) : (
          <>
            <header className="ag-head">
              <div>
                <div className="ag-head-title">{active ? active.title : 'Session'}</div>
                <div className="ag-head-meta muted">
                  {isCliSession
                    ? (active.cliLabel || 'CLI') + ' · ' + (active.cliCmd || '')
                    : (active && active.providerId) + (active && active.model ? ' · ' + active.model : '')}{' '}
                  · workspace: {active && active.workspace === '.' ? 'vault root' : active && active.workspace}
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
                  {isCliSession
                    ? 'Talk to the CLI agent like a teammate. It works inside the workspace with its own tools — every line of its real output appears here.'
                    : 'Give the agent a job. It can list and edit files in the workspace and run real commands — builds, scripts, git, anything a terminal can do.'}
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
                  <div
                    key={i}
                    className={'msg agent' + (m.error ? ' err' : '') + (m.engine === 'cli' ? ' msg-cli' : '')}
                  >
                    {m.text}
                    {m.streaming && <span className="ag-cursor" aria-hidden="true" />}
                  </div>
                )
              })}
              {running && <Typing isCli={isCliSession} />}
            </div>

            <div className="composer">
              <textarea
                rows={1}
                placeholder={
                  active && active.running
                    ? isCliSession
                      ? 'The CLI agent is working…'
                      : 'The agent is working…'
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
