import React, { useCallback, useEffect, useState } from 'react'
import { Icon } from '../icons.jsx'
import { fetchStatus, fetchPhotos, fetchAgentSessions, timeAgo } from '../api.js'
import './HomePanel.css'

// The start screen: one honest sentence from live data, four big ways to
// start, and what you touched last. Deliberately light — no canvas, no blur
// walls, nothing that makes an old phone sweat.

function powerLine(battery) {
  if (!battery || battery.present === false) return 'AC power'
  if (battery.charging) return 'charging'
  return 'battery ' + (Number.isFinite(Number(battery.level)) ? Math.round(battery.level) : '?') + '%'
}

export default function HomePanel({ onGoTo }) {
  const [status, setStatus] = useState(null)
  const [siteCount, setSiteCount] = useState(null)
  const [photoCount, setPhotoCount] = useState(null)
  const [lastSession, setLastSession] = useState(null)
  const [lastSite, setLastSite] = useState(null)

  const load = useCallback(async () => {
    try {
      setStatus(await fetchStatus())
    } catch {
      /* the sentence simply stays short */
    }
    try {
      const d = await fetch('/api/sites').then((r) => r.json())
      const sites = d.sites || []
      setSiteCount(sites.length)
      if (sites.length) {
        const newest = sites.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0]
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
      const sessions = await fetchAgentSessions()
      if (sessions.length) setLastSession(sessions[0])
    } catch {
      /* skip */
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const battery = status?.battery || {}
  const running = Boolean(lastSession && lastSession.running)
  const parts = []
  if (siteCount > 0) parts.push(siteCount + (siteCount === 1 ? ' site live' : ' sites live'))
  if (photoCount > 0) parts.push(photoCount + (photoCount === 1 ? ' photo safe' : ' photos safe'))
  if (lastSession) parts.push('agent ' + (running ? 'working' : 'idle'))
  parts.push(powerLine(battery))

  return (
    <div className="hm-panel">
      <section className="hm-hero glass">
        <div className="hm-overline">MITTICLOUD</div>
        <h1 className="hm-title">Your drawer-phone is a cloud now.</h1>
        <div className="hm-stats muted">{parts.join('  ·  ')}</div>
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
            {siteCount > 0 ? siteCount + ' hosted here' : 'LAN, Cloudflare, your domain'}
          </span>
        </button>
        <button className="hm-tile glass" onClick={() => onGoTo('remote')}>
          <span className="hm-tile-icon">
            <Icon name="bot" size={22} />
          </span>
          <span className="hm-tile-name">Remote</span>
          <span className="hm-tile-sub muted">Your agents, from anywhere</span>
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

      <button className="hm-guides muted" onClick={() => onGoTo('guides')}>
        <Icon name="shield" size={13} /> Setup checklist
      </button>
    </div>
  )
}
