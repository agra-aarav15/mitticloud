import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../icons.jsx'
import {
  fetchStatus,
  fetchPhotos,
  fetchAgentSessions,
  fetchTasks,
  humanizeUptime,
  timeAgo
} from '../api.js'
import './HomePanel.css'

// The start screen: a calm premium hero that ticks live, your real stuff as
// doors with their real numbers, and a setup guide that disappears as you
// finish. No command box on purpose — "give your cloud a job" lives in the
// agent, where jobs actually run. Deliberately light — no canvas, no blur
// walls, nothing an old phone feels.

function powerLine(battery) {
  if (!battery || battery.present === false) return 'AC power'
  if (battery.charging) return 'charging'
  return 'battery ' + (Number.isFinite(Number(battery.level)) ? Math.round(battery.level) : '?') + '%'
}

function zcodePaired() {
  try {
    return Boolean(localStorage.getItem('mitti_zcode_remote'))
  } catch {
    return false
  }
}

export default function HomePanel({ onGoTo }) {
  const [status, setStatus] = useState(null)
  const [statusAt, setStatusAt] = useState(0)
  const [sites, setSites] = useState([])
  const [photoCount, setPhotoCount] = useState(null)
  const [taskCount, setTaskCount] = useState(null)
  const [lastSession, setLastSession] = useState(null)
  const [lastSite, setLastSite] = useState(null)
  const [, setTick] = useState(0)

  // the hero ticks every second — the cloud visibly never sleeps
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000)
    return () => clearInterval(t)
  }, [])

  const load = useCallback(async () => {
    try {
      const st = await fetchStatus()
      setStatus(st)
      setStatusAt(Date.now())
    } catch {
      /* the sentence simply stays short */
    }
    try {
      const d = await fetch('/api/sites').then((r) => r.json())
      const siteList = d.sites || []
      setSites(siteList)
      if (siteList.length) {
        const newest = siteList
          .slice()
          .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0]
        setLastSite(newest)
      }
    } catch {
      /* skip */
    }
    try {
      const photos = await fetchPhotos()
      setPhotoCount(Array.isArray(photos) ? photos.length : null)
    } catch {
      /* skip */
    }
    try {
      const tasks = await fetchTasks()
      setTaskCount(Array.isArray(tasks) ? tasks.length : 0)
    } catch {
      /* skip */
    }
    try {
      const sessions = await fetchAgentSessions()
      if (sessions.length) setLastSession(sessions[0])
    } catch {
      /* skip */
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const battery = status && status.battery
  const uptimeSec = status
    ? Math.max(0, (status.uptimeSec || 0) + Math.floor((Date.now() - statusAt) / 1000))
    : 0
  const running = Boolean(lastSession && lastSession.running)
  const parts = []
  if (sites.length > 0) parts.push(sites.length + (sites.length === 1 ? ' site live' : ' sites live'))
  if (photoCount > 0) parts.push(photoCount + (photoCount === 1 ? ' photo safe' : ' photos safe'))
  if (lastSession) parts.push('agent ' + (running ? 'working' : 'idle'))
  if (status) parts.push('up ' + humanizeUptime(uptimeSec))
  parts.push(powerLine(battery))

  const steps = [
    { label: 'Host your first site', done: sites.length > 0, tab: 'host' },
    { label: 'Turn on an automation', done: (taskCount || 0) > 0, tab: 'status' },
    { label: 'Pair ZCode remote', done: zcodePaired(), tab: 'remote' }
  ]
  const pendingSteps = steps.filter((s) => !s.done)

  return (
    <div className="hm-panel">
      <section className="hm-hero glass">
        <div className="hm-overline">MITTICLOUD</div>
        <h1 className="hm-title">Your drawer-phone is a cloud now.</h1>
        <div className="hm-stats">
          <span className="livedot" aria-hidden="true" />
          {parts.join('  ·  ')}
        </div>
      </section>

      <div className="hm-tiles">
        <button className="hm-tile glass" onClick={() => onGoTo('photos')}>
          <span className="hm-tile-icon">
            <Icon name="image" size={22} />
          </span>
          <span className="hm-tile-name">Back up photos</span>
          <span className="hm-tile-sub muted">
            {photoCount > 0 ? photoCount + ' already safe' : 'Free photo vault, unlimited'}
          </span>
        </button>
        <button className="hm-tile glass" onClick={() => onGoTo('files')}>
          <span className="hm-tile-icon">
            <Icon name="folder" size={22} />
          </span>
          <span className="hm-tile-name">Open my files</span>
          <span className="hm-tile-sub muted">A real drive on the phone</span>
        </button>
        <button className="hm-tile glass" onClick={() => onGoTo('host')}>
          <span className="hm-tile-icon">
            <Icon name="globe" size={22} />
          </span>
          <span className="hm-tile-name">Host my website</span>
          <span className="hm-tile-sub muted">
            {sites.length > 0 ? sites.length + ' hosted here' : 'Free, on this phone'}
          </span>
        </button>
        <button className="hm-tile glass" onClick={() => onGoTo('remote')}>
          <span className="hm-tile-icon">
            <Icon name="bot" size={22} />
          </span>
          <span className="hm-tile-name">Remote</span>
          <span className="hm-tile-sub muted">
            {lastSession
              ? 'Your agent — ' + (running ? 'working now' : 'idle')
              : 'Your agent — give it a job'}
          </span>
        </button>
      </div>

      {(lastSession || lastSite) && (
        <section className="hm-continue glass">
          <div className="hm-label muted">Continue where you left off</div>
          {lastSession && (
            <button className="hm-row" onClick={() => onGoTo('remote')}>
              <Icon name="bot" size={15} />
              <span className="hm-row-main">{lastSession.title}</span>
              <span className="muted">
                agent · {running ? 'working now' : timeAgo(lastSession.updatedAt)}
              </span>
              <Icon name="arrowRight" size={14} />
            </button>
          )}
          {lastSite && (
            <button className="hm-row" onClick={() => onGoTo('host')}>
              <Icon name="globe" size={15} />
              <span className="hm-row-main">{lastSite.name}</span>
              <span className="muted">site · {timeAgo(lastSite.createdAt)}</span>
              <Icon name="arrowRight" size={14} />
            </button>
          )}
        </section>
      )}

      {pendingSteps.length > 0 && (
        <section className="hm-steps glass">
          <div className="hm-label muted">Finish setting up</div>
          <div className="hm-step-row">
            {pendingSteps.map((s) => (
              <button key={s.label} className="hm-step" onClick={() => onGoTo(s.tab)}>
                <span className="hm-step-num" />
                {s.label}
                <Icon name="arrowRight" size={13} />
              </button>
            ))}
          </div>
        </section>
      )}

      <button className="hm-guides muted" onClick={() => onGoTo('guides')}>
        <Icon name="shield" size={13} /> Setup checklist
      </button>
    </div>
  )
}
