import React, { useCallback, useEffect, useState } from 'react'
import { Icon } from '../icons.jsx'
import {
  fetchTasks,
  createTask,
  deleteTask,
  runTask,
  fetchTaskRuns,
  webhookUrl,
  copyText,
  timeAgo,
  toast
} from '../api.js'
import './AutomationsCard.css'

// Automations — the Tasks engine wearing plain words. Each recipe is a real
// task created through /api/tasks with a [auto]-prefixed name; the toggle
// turns it on and off, Run now fires it on the spot, and the last output is
// readable right here — no code editor anywhere on purpose.

// the server's own origin, so the recipes keep working on a custom port too
const BASE = window.location.origin

const RECIPES = [
  {
    id: 'health',
    name: '[auto] Nightly server health',
    label: 'Nightly server health',
    everyMinutes: 1440,
    desc: 'Once a night, logs RAM, uptime and whether the vault is writable — mornings start with proof the server is fine.',
    code: `const r = await fetch('${BASE}/api/health?deep=1')
const d = await r.json()
console.log('server ok:', d.ok, '| free RAM:', d.mem ? d.mem.freeMB + ' MB' : 'n/a', '| vault writable:', d.vaultWritable)`
  },
  {
    id: 'storage',
    name: '[auto] Weekly storage report',
    label: 'Weekly storage report',
    everyMinutes: 10080,
    desc: 'Every week, logs how much storage the phone has left.',
    code: `const r = await fetch('${BASE}/api/status')
const d = await r.json()
const s = d.storage || {}
console.log(s.free == null ? 'Storage unknown on this device.' : 'Free: ' + Math.round(s.free / 1e9) + ' GB | used: ' + s.usedPct + '%')`
  },
  {
    id: 'uptime',
    name: '[auto] Website uptime watch',
    label: 'Website uptime watch',
    everyMinutes: 15,
    desc: 'Every 15 minutes, opens every hosted site and logs the status codes — a dead site is caught in minutes.',
    code: `const r = await fetch('${BASE}/api/sites')
const sites = (await r.json()).sites || []
if (!sites.length) { console.log('No hosted sites yet.'); }
for (const s of sites) {
  try {
    const res = await fetch('${BASE}/s/' + s.name + '/')
    console.log('site ' + s.name + ': HTTP ' + res.status)
  } catch (e) {
    console.log('site ' + s.name + ': UNREACHABLE')
  }
}`
  }
]

function every(n) {
  return n >= 1440 ? n / 1440 + (n / 1440 === 1 ? ' day' : ' days') : n + ' min'
}

export default function AutomationsCard() {
  const [tasks, setTasks] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [openId, setOpenId] = useState(null)
  const [runs, setRuns] = useState({})
  const [gate, setGate] = useState(null)

  const load = useCallback(() => {
    fetchTasks()
      .then(setTasks)
      .catch(() => setTasks(null))
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 30000)
    return () => clearInterval(t)
  }, [load])

  const byName = (name) => (tasks || []).find((t) => t.name === name)

  const toggle = async (recipe) => {
    const existing = byName(recipe.name)
    setBusyId(recipe.id)
    try {
      if (existing) {
        await deleteTask(existing.id)
        toast('Automation off', 'ok')
      } else {
        await createTask({
          name: recipe.name,
          kind: 'js',
          code: recipe.code,
          everyMinutes: recipe.everyMinutes
        })
        toast('Automation on — first run scheduled', 'ok')
      }
      load()
    } catch (err) {
      toast(err.message, 'err')
    } finally {
      setBusyId(null)
    }
  }

  const runNow = async (task, force = false) => {
    setBusyId(task.id)
    try {
      const out = await runTask(task.id, force)
      if (out.batteryMode) {
        setGate({ task, out })
      } else {
        setGate(null)
        toast(out.ok ? 'Ran — open Last output to read it' : 'Run finished with an error', out.ok ? 'ok' : 'err')
        load()
        open(task)
      }
    } catch (err) {
      toast(err.message, 'err')
    } finally {
      setBusyId(null)
    }
  }

  const open = async (task) => {
    setOpenId((cur) => (cur === task.id ? null : task.id))
    try {
      const r = await fetchTaskRuns(task.id)
      setRuns((m) => ({ ...m, [task.id]: r }))
    } catch {
      /* leave the previous list */
    }
  }

  const onCount = tasks ? tasks.filter((t) => t.name.startsWith('[auto]')).length : 0

  return (
    <section className="st-card glass st-wide" aria-label="Automations">
      <div className="st-head">
        <span className="st-overline">
          <Icon name="bolt" size={13} />
          Automations
        </span>
        {onCount > 0 && <span className="chip chip-ok">{onCount} on</span>}
      </div>
      <div className="ac-lede muted">
        Little jobs the server runs on a schedule — flip a switch and they just happen. Run any of
        them now to watch it work.
      </div>
      {tasks === null ? (
        <div className="skeleton ac-sk" style={{ width: 220 }} />
      ) : (
        <div className="ac-list">
          {RECIPES.map((r) => {
            const t = byName(r.name)
            const on = Boolean(t)
            const list = t ? runs[t.id] || [] : []
            return (
              <div key={r.id} className={'ac-row' + (on ? ' is-on' : '')}>
                <button
                  className={'ac-switch' + (on ? ' on' : '')}
                  role="switch"
                  aria-checked={on}
                  aria-label={(on ? 'Turn off ' : 'Turn on ') + r.label}
                  disabled={busyId === r.id}
                  onClick={() => toggle(r)}
                >
                  <span className="ac-knob" aria-hidden="true" />
                </button>
                <div className="ac-text">
                  <div className="ac-name">{r.label}</div>
                  <div className="muted ac-desc">{r.desc}</div>
                  {t && (
                    <div className="ac-actions">
                      <button
                        className="ac-mini"
                        disabled={busyId === t.id}
                        onClick={() => runNow(t)}
                      >
                        {busyId === t.id ? <span className="spin" aria-hidden="true" /> : <Icon name="bolt" size={12} />}
                        Run now
                      </button>
                      <button className="ac-mini" onClick={() => open(t)}>
                        <Icon name="file" size={12} />
                        {openId === t.id ? 'Hide output' : 'Last output'}
                      </button>
                      <button
                        className="ac-mini"
                        onClick={async () => {
                          const ok = await copyText(webhookUrl(t.webhookId))
                          toast(ok ? 'Secret webhook link copied' : "Couldn't copy — the link is " + webhookUrl(t.webhookId), ok ? 'ok' : 'info')
                        }}
                        title={webhookUrl(t.webhookId)}
                      >
                        <Icon name="link" size={12} />
                        Webhook
                      </button>
                    </div>
                  )}
                  {t && t.lastRunAt && (
                    <div className="muted ac-last">
                      {t.lastStatus === 'ok' ? 'Last run ok' : 'Last run ' + (t.lastStatus || '')} ·{' '}
                      {timeAgo(t.lastRunAt)} · every {every(t.everyMinutes)}
                    </div>
                  )}
                  {t && !t.lastRunAt && t.lastDeferredAt && (
                    <div className="muted ac-last">
                      Waiting for power — deferred {timeAgo(t.lastDeferredAt)} (runs when charging)
                    </div>
                  )}
                  {t && openId === t.id && (
                    <div className="ac-output">
                      {list.length === 0 ? (
                        <div className="muted">No runs recorded yet.</div>
                      ) : (
                        list.slice(0, 3).map((run, i) => (
                          <div key={i} className="ac-run">
                            <div className="ac-run-head muted">
                              {run.status === 'ok' ? 'ok' : run.status} · {timeAgo(run.at)} · {run.ms} ms
                            </div>
                            <pre className="ac-run-body">{(run.stdout || '').trim() || run.error || '(no output)'}</pre>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                  {gate && gate.task.id === t.id && (
                    <div className="ac-gate">
                      <Icon name="alert" size={13} />
                      <span>{gate.out.error || 'Phone is on battery — this could heat it.'}</span>
                      <button className="ac-mini" onClick={() => runNow(gate.task, true)}>
                        Run anyway
                      </button>
                      <button className="ac-mini" onClick={() => setGate(null)}>
                        Not now
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}