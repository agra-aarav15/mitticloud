import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../icons.jsx'
import { GUIDE_STEPS } from '../guides.js'
import { fetchStatus, fetchTasks, toast } from '../api.js'
import './GuidesPanel.css'

const POLL_MS = 30000

/**
 * Pass/pending per step, computed from REAL backend state:
 * - termux:    device.termux === true
 * - battery:   battery.mocked === false (real battery reporting on the device)
 * - lan:       always (the server is answering if you can read this)
 * - tailscale: tunnel.mode === 'tailscale'
 * - first-task: /api/tasks returns at least one task
 * - first-site: /api/sites returns at least one hosted site
 * - bridge:    /api/bridge/sessions returns at least one Cloud Mode session
 * - phone-app: MittiCloud is running inside Termux (device.termux)
 */
function computePass(status, tasks, sites, sessions) {
  const device = (status && status.device) || {}
  const battery = (status && status.battery) || {}
  const tunnel = (status && status.tunnel) || {}
  return {
    termux: device.termux === true,
    battery: battery.mocked === false,
    lan: true,
    tailscale: tunnel.mode === 'tailscale',
    'first-task': Array.isArray(tasks) && tasks.length >= 1,
    'first-site': Array.isArray(sites) && sites.length >= 1,
    bridge: Array.isArray(sessions) && sessions.length >= 1,
    'phone-app': device.termux === true
  }
}

async function copyText(text, msg) {
  try {
    await navigator.clipboard.writeText(text)
    toast(msg || 'Copied', 'ok')
  } catch {
    toast('Could not copy — ' + text, 'err')
  }
}

export default function GuidesPanel({ onGoTo }) {
  const [status, setStatus] = useState(null)
  const [tasks, setTasks] = useState(null)
  const [sites, setSites] = useState(null)
  const [sessions, setSessions] = useState(null)
  const [open, setOpen] = useState(() => new Set())
  const autoOpenedRef = useRef(false)

  const load = useCallback(async () => {
    try {
      setStatus(await fetchStatus())
    } catch {
      // keep the last known values; the checklist degrades to pending
    }
    try {
      setTasks(await fetchTasks())
    } catch {
      // tasks stay unknown; first-task stays pending
    }
    try {
      const r = await fetch('/api/sites')
      const body = await r.json()
      setSites(body.sites || [])
    } catch {
      // sites stay unknown; first-site stays pending
    }
    try {
      const r = await fetch('/api/bridge/sessions')
      const body = await r.json()
      setSessions(body.sessions || [])
    } catch {
      // sessions stay unknown; bridge stays pending
    }
  }, [])

  useEffect(() => {
    load()
    const timer = setInterval(load, POLL_MS)
    return () => clearInterval(timer)
  }, [load])

  const pass = useMemo(
    () => computePass(status, tasks, sites, sessions),
    [status, tasks, sites, sessions]
  )

  // Open the first pending step once, so the next action is visible.
  useEffect(() => {
    if (autoOpenedRef.current || !status) return
    autoOpenedRef.current = true
    const firstPending = GUIDE_STEPS.find((s) => !pass[s.id])
    if (firstPending) setOpen(new Set([firstPending.id]))
  }, [status, pass])

  const toggleOpen = (id) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const device = (status && status.device) || {}
  const tunnel = (status && status.tunnel) || {}
  const lanUrls = Array.isArray(device.lanUrls) ? device.lanUrls : []

  const readyCount = GUIDE_STEPS.filter((s) => pass[s.id]).length
  const pct = Math.round((readyCount / GUIDE_STEPS.length) * 100)

  const renderBody = (s) => (
    <div className="gd-body">
      {s.desktopNote && <div className="gd-note muted">{s.desktopNote}</div>}
      <ul className="gd-points">
        {s.pending.map((p, j) => (
          <li key={j}>{p}</li>
        ))}
      </ul>
      {s.cta && (
        <div>
          <button className="btn btn-primary gd-cta" onClick={() => onGoTo && onGoTo(s.cta.tab)}>
            <Icon name="bolt" size={15} />
            {s.cta.label}
          </button>
        </div>
      )}
    </div>
  )

  return (
    <div className="gd-panel">
      <div className="gd-toolbar">
        <div>
          <div className="gd-title">Living checklist</div>
          <div className="gd-subtitle muted">Reads real system state — useful long after install</div>
        </div>
        <button className="btn iconbtn" onClick={load} aria-label="Refresh checklist" title="Refresh">
          <Icon name="refresh" size={16} />
        </button>
      </div>

      <section className="gd-progress glass" aria-label="Checklist progress">
        <div className="gd-progress-row">
          <span className="gd-progress-label">
            {readyCount}/{GUIDE_STEPS.length} ready
          </span>
          {readyCount === GUIDE_STEPS.length && <span className="chip chip-ok">All set</span>}
        </div>
        <div
          className="gd-track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={GUIDE_STEPS.length}
          aria-valuenow={readyCount}
        >
          <div className="gd-fill" style={{ width: pct + '%' }} />
        </div>
      </section>

      {!status && (
        <section className="gd-step glass" aria-hidden="true">
          <div className="gd-head">
            <div className="skeleton gd-sk-dot" />
            <div className="skeleton gd-sk-line" style={{ width: 180 }} />
          </div>
        </section>
      )}

      {status &&
        GUIDE_STEPS.map((s) => {
          const isPass = Boolean(pass[s.id])
          const isOpen = open.has(s.id)
          return (
            <section key={s.id} className={'gd-step glass' + (isPass ? ' is-pass' : '')}>
              <div
                className={'gd-head' + (isPass ? '' : ' is-clickable')}
                onClick={isPass ? undefined : () => toggleOpen(s.id)}
                role={isPass ? undefined : 'button'}
                tabIndex={isPass ? undefined : 0}
                aria-expanded={isPass ? undefined : isOpen}
                onKeyDown={
                  isPass
                    ? undefined
                    : (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          toggleOpen(s.id)
                        }
                      }
                }
              >
                <span className={'gd-dot' + (isPass ? ' is-pass' : '')} aria-hidden="true" />
                <span className="gd-name">{s.title}</span>
                {s.id === 'termux' && !isPass && <span className="chip chip-warn">desktop demo</span>}
                <span className={'gd-state' + (isPass ? ' is-pass' : '')}>
                  {isPass ? 'ready' : 'pending'}
                </span>
                {!isPass && (
                  <Icon
                    name="chevronUp"
                    size={15}
                    className={'gd-chevron' + (isOpen ? '' : ' is-flip')}
                  />
                )}
              </div>

              {s.id === 'lan' && (
                <div className="gd-urls">
                  {lanUrls.length === 0 && (
                    <div className="gd-url muted">{tunnel.hint || 'Open http://localhost:7333 on the phone.'}</div>
                  )}
                  {lanUrls.map((u) => (
                    <div key={u} className="gd-url">
                      <button
                        type="button"
                        className="gd-url-text"
                        onClick={() => copyText(u, 'URL copied')}
                        title={'Copy ' + u}
                      >
                        {u}
                      </button>
                      <button
                        type="button"
                        className="btn iconbtn gd-url-copy"
                        onClick={() => copyText(u, 'URL copied')}
                        aria-label={'Copy ' + u}
                        title="Copy URL"
                      >
                        <Icon name="upload" size={14} />
                      </button>
                    </div>
                  ))}
                  <div className="gd-url-hint muted">
                    On the phone itself: http://localhost:7333 · from any device on the same Wi-Fi: a URL above.
                  </div>
                </div>
              )}

              {!isPass && isOpen && renderBody(s)}
            </section>
          )
        })}
    </div>
  )
}
