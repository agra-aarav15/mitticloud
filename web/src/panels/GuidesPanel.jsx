import React, { useEffect, useState } from 'react'
import { Icon } from '../icons.jsx'
import { GUIDES } from '../guides.js'
import './GuidesPanel.css'

const STORE_KEY = 'mitticloud.guides.v1'

function loadState() {
  try {
    const d = JSON.parse(localStorage.getItem(STORE_KEY) || 'null')
    const done = {}
    if (d && d.done && typeof d.done === 'object') {
      for (const s of GUIDES) if (d.done[s.id]) done[s.id] = true
    }
    const open = Array.isArray(d && d.open)
      ? d.open.filter((id) => GUIDES.some((s) => s.id === id))
      : [GUIDES[0].id]
    return { done, open }
  } catch {
    return { done: {}, open: [GUIDES[0].id] }
  }
}

export default function GuidesPanel() {
  const [state, setState] = useState(loadState)
  const { done, open } = state

  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state))
    } catch {
      // storage full/blocked — not worth surfacing
    }
  }, [state])

  const doneCount = GUIDES.filter((s) => done[s.id]).length
  const pct = Math.round((doneCount / GUIDES.length) * 100)

  const toggleOpen = (id) =>
    setState((st) => ({
      ...st,
      open: st.open.includes(id) ? st.open.filter((x) => x !== id) : [...st.open, id]
    }))

  const toggleDone = (id) =>
    setState((st) => {
      const next = { ...st.done }
      if (next[id]) delete next[id]
      else next[id] = true
      return { ...st, done: next }
    })

  return (
    <div className="gd-panel">
      <div className="gd-toolbar">
        <div>
          <div className="gd-title">Guided setup</div>
          <div className="gd-subtitle muted">From drawer-phone to pocket cloud, step by step</div>
        </div>
      </div>

      <section className="gd-progress glass" aria-label="Setup progress">
        <div className="gd-progress-row">
          <span className="gd-progress-label">
            Setup {doneCount}/{GUIDES.length} complete
          </span>
          {doneCount === GUIDES.length && <span className="chip chip-ok">All set</span>}
        </div>
        <div
          className="gd-track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={GUIDES.length}
          aria-valuenow={doneCount}
        >
          <div className="gd-fill" style={{ width: pct + '%' }} />
        </div>
      </section>

      {GUIDES.map((s, i) => {
        const isOpen = open.includes(s.id)
        const isDone = Boolean(done[s.id])
        return (
          <section
            key={s.id}
            className={'gd-step glass' + (isOpen ? ' is-open' : '') + (isDone ? ' is-done' : '')}
          >
            <button
              type="button"
              className="gd-head"
              onClick={() => toggleOpen(s.id)}
              aria-expanded={isOpen}
              aria-controls={'gd-body-' + s.id}
            >
              <span className="gd-num" aria-hidden="true">
                {isDone ? <Icon name="check" size={13} /> : i + 1}
              </span>
              <span className="gd-name">{s.title}</span>
              <span className="chip gd-min">{s.minutes} min</span>
              <Icon name="chevronUp" size={15} className={'gd-chevron' + (isOpen ? '' : ' is-flip')} />
            </button>
            {isOpen && (
              <div className="gd-body" id={'gd-body-' + s.id}>
                <ul className="gd-points">
                  {s.points.map((p, j) => (
                    <li key={j}>{p}</li>
                  ))}
                </ul>
                <label className="gd-donelabel">
                  <input type="checkbox" checked={isDone} onChange={() => toggleDone(s.id)} />
                  <span className="gd-box" aria-hidden="true">
                    <Icon name="check" size={12} />
                  </span>
                  Done
                </label>
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}
