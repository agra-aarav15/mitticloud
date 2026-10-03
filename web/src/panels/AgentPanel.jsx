import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../icons.jsx'
import { timeAgo, toast } from '../api.js'
import './AgentPanel.css'

const POLL_MS = 30000
const MIN_SCHEDULE = 5
const MAX_SCHEDULE = 1440

// api.js cannot carry these yet (do-not-modify), so the panel owns its calls.
async function j(res) {
  const d = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(d.error || res.statusText), { status: res.status })
  return d
}

const getAgent = () => fetch('/api/agent').then(j)

const putAgent = (patch) =>
  fetch('/api/agent', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch)
  }).then(j)

const runAgent = (force = false) =>
  fetch('/api/agent/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force })
  }).then(j)

const getAgentRuns = () => fetch('/api/agent/runs').then(j).then((d) => d.runs || [])

function nextRunHint(info) {
  if (!info) return ''
  if (!info.enabled) return 'Agent is off — flip the switch or use Run now.'
  if (!info.hasKey) return 'Waiting for a Gemini key.'
  if (!Number.isInteger(info.scheduleMinutes)) return 'Manual only — use Run now.'
  return 'Runs about every ' + info.scheduleMinutes + ' min · last run ' + timeAgo(info.lastRunAt)
}

export default function AgentPanel() {
  const [info, setInfo] = useState(null) // null = loading
  const [runs, setRuns] = useState([])
  const [form, setForm] = useState({ instruction: '', scheduleMinutes: '60', key: '' })
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [toggling, setToggling] = useState(false)
  const [gate, setGate] = useState(null) // battery-mode gate from the server
  const mountedRef = useRef(true)
  const formInitRef = useRef(false)

  const load = useCallback(async () => {
    try {
      const d = await getAgent()
      if (!mountedRef.current) return
      setInfo(d)
      // fill the form once from the server; later polls never clobber typing
      if (!formInitRef.current) {
        formInitRef.current = true
        setForm((f) => ({
          ...f,
          instruction: d.instruction || '',
          scheduleMinutes: d.scheduleMinutes != null ? String(d.scheduleMinutes) : '60'
        }))
      }
    } catch {
      if (mountedRef.current) setInfo({ enabled: false, hasKey: false, instruction: '', scheduleMinutes: null, lastRunAt: null })
    }
  }, [])

  const loadRuns = useCallback(async () => {
    try {
      const list = await getAgentRuns()
      if (mountedRef.current) setRuns(list)
    } catch {
      // keep whatever we had — history is non-critical
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    load()
    loadRuns()
    const timer = setInterval(() => {
      load()
      loadRuns()
    }, POLL_MS)
    return () => {
      mountedRef.current = false
      clearInterval(timer)
    }
  }, [load, loadRuns])

  const toggleEnabled = async () => {
    if (!info || toggling) return
    setToggling(true)
    try {
      const d = await putAgent({ enabled: !info.enabled })
      if (mountedRef.current) setInfo((cur) => (cur ? { ...cur, ...d } : d))
      toast(d.enabled ? 'Agent enabled' : 'Agent disabled', 'ok')
    } catch (err) {
      toast(err.message || 'Could not update the agent', 'err')
    } finally {
      if (mountedRef.current) setToggling(false)
    }
  }

  const save = async (e) => {
    e.preventDefault()
    const instruction = form.instruction.trim()
    if (!instruction) {
      toast('Write a standing instruction first', 'info')
      return
    }
    const n = Number(form.scheduleMinutes)
    if (!Number.isInteger(n) || n < MIN_SCHEDULE || n > MAX_SCHEDULE) {
      toast('Schedule must be ' + MIN_SCHEDULE + '–' + MAX_SCHEDULE + ' minutes', 'err')
      return
    }
    const patch = { instruction, scheduleMinutes: n }
    if (form.key.trim() !== '') patch.key = form.key.trim()
    setSaving(true)
    try {
      const d = await putAgent(patch)
      if (mountedRef.current) setInfo((cur) => (cur ? { ...cur, ...d } : d))
      setForm((f) => ({ ...f, key: '' }))
      toast('Agent settings saved', 'ok')
    } catch (err) {
      toast(err.message || 'Could not save the settings', 'err')
    } finally {
      if (mountedRef.current) setSaving(false)
    }
  }

  // Same interaction as the Sandbox battery gate: batteryMode -> banner with
  // "Run anyway" -> re-post with force:true.
  const run = async (force = false) => {
    if (running) return
    setRunning(true)
    setGate(null)
    try {
      const d = await runAgent(force)
      if (d && d.batteryMode) {
        if (mountedRef.current) setGate(d)
        return
      }
      if (d && d.needsKey) {
        toast('Add a Gemini key first — free at aistudio.google.com', 'err')
        return
      }
      if (d && d.ok) {
        toast('Agent finished · ' + (d.toolCalls || 0) + ' tool call(s) · ' + d.ms + ' ms', 'ok')
      } else {
        toast('Agent run failed — ' + ((d && d.error) || 'see run history'), 'err')
      }
    } catch (err) {
      toast(err.message || 'Could not run the agent', 'err')
    } finally {
      if (mountedRef.current) {
        setRunning(false)
        load()
        loadRuns()
      }
    }
  }

  const enabled = Boolean(info && info.enabled)
  const hasKey = Boolean(info && info.hasKey)

  return (
    <div className="ag-panel">
      <div className="ag-toolbar">
        <div>
          <div className="ag-title">MittiAgent</div>
          <div className="ag-subtitle muted">A background helper that works on a schedule — battery-aware</div>
        </div>
        <div className="ag-toolbar-actions">
          <button className="btn ag-run" onClick={() => run()} disabled={running || toggling}>
            <Icon name="bolt" size={14} />
            {running ? 'Running…' : 'Run now'}
          </button>
          <button
            className={'ag-switch' + (enabled ? ' on' : '')}
            role="switch"
            aria-checked={enabled}
            aria-label={enabled ? 'Disable MittiAgent' : 'Enable MittiAgent'}
            onClick={toggleEnabled}
            disabled={toggling || !info}
          >
            <span className="ag-knob" aria-hidden="true" />
          </button>
        </div>
      </div>

      {gate && (
        <div className="banner ag-banner" role="status">
          <Icon name="alert" size={15} />
          <span className="ag-banner-msg">{gate.message}</span>
          <button className="btn ag-banner-btn" onClick={() => run(true)}>
            Run anyway
          </button>
          <button
            className="btn iconbtn"
            onClick={() => setGate(null)}
            aria-label="Dismiss warning"
            title="Dismiss"
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      )}

      <section className="ag-status glass">
        <span className={'chip' + (enabled ? ' chip-ok' : '')}>{enabled ? 'Enabled' : 'Off'}</span>
        <span className={'chip' + (hasKey ? ' chip-ok' : '')}>
          Gemini key: {hasKey ? 'set' : 'missing'}
        </span>
        <span className="ag-nextrun muted">{nextRunHint(info)}</span>
      </section>
      {info && !hasKey && (
        <div className="ag-keyhint muted">Add a free key from aistudio.google.com in the key field below.</div>
      )}

      <form className="ag-form glass" onSubmit={save}>
        <label className="ag-label muted" htmlFor="ag-instruction">
          Standing instruction
        </label>
        <textarea
          id="ag-instruction"
          className="ag-instruction"
          value={form.instruction}
          onChange={(e) => setForm((f) => ({ ...f, instruction: e.target.value }))}
          placeholder="Every morning check the workspace and write a note about what changed"
          aria-label="Standing instruction"
          maxLength={4000}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          disabled={saving}
        />
        <div className="ag-form-foot">
          <div className="ag-fields">
            <label className="ag-every">
              <span className="muted">Every</span>
              <input
                className="ag-input ag-input-num"
                type="number"
                min={MIN_SCHEDULE}
                max={MAX_SCHEDULE}
                value={form.scheduleMinutes}
                onChange={(e) => setForm((f) => ({ ...f, scheduleMinutes: e.target.value }))}
                aria-label="Schedule in minutes"
                disabled={saving}
              />
              <span className="muted">min</span>
            </label>
            <input
              className="ag-input ag-key"
              type="password"
              value={form.key}
              onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))}
              placeholder={hasKey ? 'Key is set — type to replace' : 'Gemini API key'}
              aria-label="Gemini API key"
              autoComplete="off"
              disabled={saving}
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>

      <section className="ag-history glass">
        <div className="ag-hist-head">
          <span className="ag-overline">Run history</span>
          <span className="muted ag-hist-count">{runs.length}</span>
        </div>
        {info === null ? (
          <div className="ag-hist-loading muted">Loading…</div>
        ) : runs.length === 0 ? (
          <div className="ag-hist-empty muted">No runs yet — press Run now or wait for the schedule.</div>
        ) : (
          <ul className="ag-runs">
            {runs.map((r, i) => (
              <li key={i} className="ag-run">
                <div className="ag-run-head">
                  {r.deferred ? (
                    <span className="chip">deferred</span>
                  ) : (
                    <span className={'chip' + (r.ok ? ' chip-ok' : '')}>{r.ok ? 'ok' : 'fail'}</span>
                  )}
                  <span className="muted">{timeAgo(r.at)}</span>
                  <span className="muted">{r.toolCalls || 0} tool call(s)</span>
                  <span className="muted">{r.ms} ms</span>
                </div>
                {r.say ? <p className="ag-say">{r.say}</p> : null}
                {r.error ? <pre className="ag-err">{r.error}</pre> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
