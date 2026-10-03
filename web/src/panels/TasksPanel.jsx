import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../icons.jsx'
import {
  fetchTasks,
  createTask,
  updateTask,
  deleteTask,
  runTask,
  webhookPath,
  webhookUrl,
  timeAgo,
  toast
} from '../api.js'
import './TasksPanel.css'

const POLL_MS = 30000
const LANGS = [
  { id: 'js', label: 'js' },
  { id: 'python', label: 'python' }
]

const BLANK_FORM = { name: '', kind: 'js', code: '', everyMinutes: '' }

function fmtSchedule(mins) {
  if (!Number.isInteger(mins)) return 'manual'
  if (mins >= 1440 && mins % 1440 === 0) return 'every ' + mins / 1440 + ' d'
  if (mins >= 60 && mins % 60 === 0) return 'every ' + mins / 60 + ' h'
  return 'every ' + mins + ' min'
}

const cap = (s) => (typeof s === 'string' && s.length > 2000 ? s.slice(0, 2000) : s)

export default function TasksPanel() {
  const [tasks, setTasks] = useState(null) // null = loading
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [form, setForm] = useState(BLANK_FORM)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState(null)
  const [expanded, setExpanded] = useState(() => new Set())
  const mountedRef = useRef(true)

  const load = useCallback(async () => {
    try {
      const list = await fetchTasks()
      if (!mountedRef.current) return
      setTasks(list)
    } catch {
      if (mountedRef.current) setTasks([])
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

  const openNew = () => {
    setEditingId(null)
    setForm(BLANK_FORM)
    setFormOpen(true)
  }

  const openEdit = (task) => {
    setEditingId(task.id)
    setForm({
      name: task.name,
      kind: task.kind === 'python' ? 'python' : 'js',
      code: task.code || '',
      everyMinutes: Number.isInteger(task.everyMinutes) ? String(task.everyMinutes) : ''
    })
    setFormOpen(true)
  }

  const closeForm = () => {
    setFormOpen(false)
    setEditingId(null)
    setForm(BLANK_FORM)
  }

  const submit = async (e) => {
    e.preventDefault()
    const name = form.name.trim()
    const code = form.code
    if (!name) {
      toast('Give the task a name first', 'info')
      return
    }
    if (!code.trim()) {
      toast('Write the code to run first', 'info')
      return
    }
    const payload = { name, kind: form.kind, code }
    if (form.everyMinutes !== '') {
      const n = Number(form.everyMinutes)
      if (!Number.isInteger(n) || n < 1 || n > 10080) {
        toast('everyMinutes must be 1–10080, or blank for manual', 'err')
        return
      }
      payload.everyMinutes = n
    }
    setSaving(true)
    try {
      if (editingId) {
        await updateTask(editingId, payload)
        toast('Task saved', 'ok')
      } else {
        await createTask(payload)
        toast('Task created', 'ok')
      }
      closeForm()
      await load()
    } catch (err) {
      toast(err.message || 'Could not save the task', 'err')
    } finally {
      if (mountedRef.current) setSaving(false)
    }
  }

  const copyWebhook = async (task) => {
    const url = webhookUrl(task.webhookId)
    try {
      await navigator.clipboard.writeText(url)
      toast('Webhook URL copied', 'ok')
    } catch {
      toast('Could not copy — ' + url, 'err')
    }
  }

  const toggleEnabled = async (task) => {
    setBusyId(task.id)
    try {
      await updateTask(task.id, { enabled: !task.enabled })
      await load()
    } catch (err) {
      toast(err.message || 'Could not update the task', 'err')
    } finally {
      if (mountedRef.current) setBusyId(null)
    }
  }

  const runNow = async (task) => {
    setBusyId(task.id)
    try {
      const out = await runTask(task.id)
      if (out.status === 'deferred') {
        toast('Deferred — ' + (out.error || 'battery mode'), 'info')
      } else if (out.status === 'ok') {
        toast('Task ran ok · ' + out.ms + ' ms', 'ok')
      } else {
        toast('Task failed — see its run history', 'err')
      }
      await load()
    } catch (err) {
      toast(err.message || 'Could not run the task', 'err')
    } finally {
      if (mountedRef.current) setBusyId(null)
    }
  }

  const remove = async (task) => {
    if (!window.confirm('Delete "' + task.name + '"? Its webhook stops working too.')) return
    setBusyId(task.id)
    try {
      await deleteTask(task.id)
      toast('Task deleted', 'ok')
      await load()
    } catch (err) {
      toast(err.message || 'Could not delete the task', 'err')
    } finally {
      if (mountedRef.current) setBusyId(null)
    }
  }

  const toggleExpanded = (id) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div className="tk-panel">
      <div className="tk-toolbar">
        <div>
          <div className="tk-title">MittiOps</div>
          <div className="tk-subtitle muted">Scheduled jobs &amp; webhooks — battery-aware</div>
        </div>
        {!formOpen && (
          <button className="btn btn-primary" onClick={openNew}>
            <Icon name="plus" size={15} />
            New Task
          </button>
        )}
      </div>

      {formOpen && (
        <form className="tk-form glass" onSubmit={submit}>
          <div className="tk-form-row">
            <input
              className="tk-input"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Task name"
              aria-label="Task name"
              maxLength={120}
              disabled={saving}
            />
            <div className="tk-langs" role="group" aria-label="Language">
              {LANGS.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  className={'tk-lang' + (form.kind === l.id ? ' active' : '')}
                  aria-pressed={form.kind === l.id}
                  onClick={() => setForm((f) => ({ ...f, kind: l.id }))}
                >
                  {l.label}
                </button>
              ))}
            </div>
          </div>
          <textarea
            className="tk-code"
            value={form.code}
            onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
            placeholder={form.kind === 'js' ? "console.log('hello from MittiOps')" : "print('hello from MittiOps')"}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            aria-label="Task code"
            maxLength={10000}
            disabled={saving}
          />
          <div className="tk-form-foot">
            <label className="tk-every">
              <span className="muted">Every</span>
              <input
                className="tk-input tk-input-num"
                type="number"
                min={1}
                max={10080}
                value={form.everyMinutes}
                onChange={(e) => setForm((f) => ({ ...f, everyMinutes: e.target.value }))}
                placeholder="manual"
                aria-label="Run interval in minutes"
                disabled={saving}
              />
              <span className="muted">min</span>
            </label>
            <div className="tk-form-actions">
              <button type="button" className="btn" onClick={closeForm} disabled={saving}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? 'Saving…' : editingId ? 'Save' : 'Create'}
              </button>
            </div>
          </div>
        </form>
      )}

      {tasks === null ? (
        <div className="tk-card glass" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="tk-row skeleton-row">
              <div className="skeleton tk-sk-line" style={{ width: i === 0 ? 160 : 120 }} />
              <div className="skeleton tk-sk-line" style={{ width: 90 }} />
            </div>
          ))}
        </div>
      ) : tasks.length === 0 && !formOpen ? (
        <div className="empty">
          <div className="btn iconbtn" aria-hidden="true">
            <Icon name="bolt" size={22} />
          </div>
          No tasks yet — schedule your first job.
          <div>
            <button className="btn btn-primary tk-empty-cta" onClick={openNew}>
              <Icon name="plus" size={15} />
              New Task
            </button>
          </div>
        </div>
      ) : (
        tasks.map((task) => {
          const isOpen = expanded.has(task.id)
          const deferred = task.lastStatus === 'deferred'
          return (
            <section key={task.id} className={'tk-card glass' + (task.enabled ? '' : ' is-disabled')}>
              <div className="tk-card-head">
                <div className="tk-card-title">
                  <span className="tk-name">{task.name}</span>
                  <span className="chip">{task.kind}</span>
                  <span className="chip">{fmtSchedule(task.everyMinutes)}</span>
                  {deferred && <span className="chip chip-warn">battery mode</span>}
                </div>
                <div className="tk-card-actions">
                  <button
                    className="btn tk-run"
                    onClick={() => runNow(task)}
                    disabled={busyId === task.id || !task.enabled}
                    title={task.enabled ? 'Run this task now' : 'Enable the task to run it'}
                  >
                    <Icon name="bolt" size={14} />
                    Run now
                  </button>
                  <button
                    className={'tk-switch' + (task.enabled ? ' on' : '')}
                    role="switch"
                    aria-checked={task.enabled}
                    aria-label={(task.enabled ? 'Disable ' : 'Enable ') + task.name}
                    onClick={() => toggleEnabled(task)}
                    disabled={busyId === task.id}
                  >
                    <span className="tk-knob" aria-hidden="true" />
                  </button>
                  <button
                    className="btn iconbtn"
                    onClick={() => openEdit(task)}
                    aria-label={'Edit ' + task.name}
                    title="Edit"
                    disabled={busyId === task.id}
                  >
                    <Icon name="file" size={15} />
                  </button>
                  <button
                    className="btn iconbtn btn-danger"
                    onClick={() => remove(task)}
                    aria-label={'Delete ' + task.name}
                    title="Delete"
                    disabled={busyId === task.id}
                  >
                    <Icon name="trash" size={15} />
                  </button>
                </div>
              </div>

              <div className="tk-meta">
                <button
                  type="button"
                  className="tk-hook"
                  onClick={() => copyWebhook(task)}
                  title="Copy the full webhook URL"
                >
                  <span className="tk-hook-path">POST {webhookPath(task.webhookId)}</span>
                  <Icon name="upload" size={12} />
                </button>
                <span className="tk-last muted">
                  {task.lastStatus ? (
                    <>
                      <span className={'tk-status tk-status-' + task.lastStatus}>{task.lastStatus}</span>
                      {' · '}
                      {timeAgo(task.lastRunAt)}
                      {typeof task.lastDurationMs === 'number' && task.lastStatus !== 'deferred'
                        ? ' · ' + task.lastDurationMs + ' ms'
                        : ''}
                    </>
                  ) : (
                    'never run'
                  )}
                </span>
              </div>

              {(task.runs || []).length > 0 && (
                <button
                  type="button"
                  className="tk-history-toggle"
                  onClick={() => toggleExpanded(task.id)}
                  aria-expanded={isOpen}
                >
                  <Icon
                    name="chevronUp"
                    size={14}
                    className={'tk-chevron' + (isOpen ? '' : ' is-flip')}
                  />
                  Run history ({task.runs.length})
                </button>
              )}
              {isOpen && (
                <ul className="tk-runs">
                  {(task.runs || []).map((r, i) => (
                    <li key={i} className="tk-run">
                      <div className="tk-run-head">
                        <span className={'tk-status tk-status-' + r.status}>{r.status}</span>
                        <span className="muted">{timeAgo(r.at)}</span>
                        <span className="muted">{r.ms} ms</span>
                      </div>
                      {r.stdout ? <pre className="tk-pre">{cap(r.stdout)}</pre> : null}
                      {r.error ? <pre className="tk-pre tk-err">{cap(r.error)}</pre> : null}
                      {!r.stdout && !r.error ? <pre className="tk-pre muted">(no output)</pre> : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )
        })
      )}
    </div>
  )
}
