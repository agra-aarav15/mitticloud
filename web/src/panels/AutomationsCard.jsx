import React, { useCallback, useEffect, useState } from 'react'
import { Icon } from '../icons.jsx'
import { fetchTasks, createTask, deleteTask, timeAgo, toast } from '../api.js'
import './AutomationsCard.css'

// Automations — the Tasks engine wearing plain words. Each recipe is a real
// task created through /api/tasks with a [auto]-prefixed name; the toggle
// turns it on and off. No code editor anywhere on purpose.

const BASE = 'http://127.0.0.1:7333'

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

export default function AutomationsCard() {
  const [tasks, setTasks] = useState(null)
  const [busyId, setBusyId] = useState(null)

  const load = useCallback(() => {
    fetchTasks()
      .then(setTasks)
      .catch(() => setTasks([]))
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

  const onCount = tasks ? tasks.filter((t) => t.name.startsWith('[auto]')).length : null

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
        Little jobs the server runs on a schedule — flip a switch and they just happen.
      </div>
      {tasks === null ? (
        <div className="skeleton ac-sk" style={{ width: 220 }} />
      ) : (
        <div className="ac-list">
          {RECIPES.map((r) => {
            const t = byName(r.name)
            const on = Boolean(t)
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
                  {t && t.lastRunAt && (
                    <div className="muted ac-last">
                      {t.lastStatus === 'ok' ? 'Last run ok' : 'Last run ' + (t.lastStatus || '')} ·{' '}
                      {timeAgo(t.lastRunAt)} · every {t.everyMinutes >= 1440 ? t.everyMinutes / 1440 + ' day' : t.everyMinutes + ' min'}
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
