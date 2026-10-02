import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../icons.jsx'
import { fetchStatus, humanizeBytes, humanizeUptime } from '../api.js'
import './StatusPanel.css'

const POLL_MS = 30000

const TUNNEL_LABELS = {
  lan: 'Local network',
  tailscale: 'Tailscale',
  cloudflared: 'Cloudflare Tunnel'
}

function CardHead({ icon, label, mocked, light }) {
  return (
    <div className="st-head">
      <span className="st-overline">
        <Icon name={icon} size={13} />
        {label}
      </span>
      {light && <span className="chip chip-warn">Light mode</span>}
      {mocked && <span className="chip chip-warn">Mocked</span>}
    </div>
  )
}

function RingGauge({ level, low, label }) {
  const r = 52
  const c = 2 * Math.PI * r
  const pct = level == null ? 0 : Math.max(0, Math.min(100, level))
  const target = c * (1 - pct / 100)
  const [dash, setDash] = useState(c)

  // Draw the ring in from empty on mount, then let CSS transitions handle updates.
  useEffect(() => {
    const id = requestAnimationFrame(() => setDash(target))
    return () => cancelAnimationFrame(id)
  }, [target])

  return (
    <svg className="st-ring" viewBox="0 0 120 120" role="img" aria-label={label}>
      <defs>
        <linearGradient id="st-ring-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3b82f6" />
          <stop offset="1" stopColor="#22d3ee" />
        </linearGradient>
      </defs>
      <circle className="st-ring-track" cx="60" cy="60" r={r} />
      <circle
        className={'st-ring-fill' + (low ? ' is-low' : '')}
        cx="60"
        cy="60"
        r={r}
        stroke={low ? undefined : 'url(#st-ring-grad)'}
        strokeDasharray={c}
        strokeDashoffset={dash}
        transform="rotate(-90 60 60)"
      />
      <text className="st-ring-num" x="60" y="68" textAnchor="middle">
        {level == null ? '—' : Math.round(pct)}
        {level != null && <tspan className="st-ring-pct">%</tspan>}
      </text>
    </svg>
  )
}

export default function StatusPanel() {
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [offline, setOffline] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const mountedRef = useRef(true)

  // Silent loader: returns success so callers decide how to surface failures.
  const load = useCallback(async () => {
    try {
      const d = await fetchStatus()
      if (!mountedRef.current) return true
      setStatus(d)
      setOffline(false)
      return true
    } catch {
      return false
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    ;(async () => {
      const ok = await load()
      if (!mountedRef.current) return
      setLoading(false)
      if (!ok) setOffline(true)
    })()

    const timer = setInterval(() => {
      load()
    }, POLL_MS)
    const onVis = () => {
      if (document.visibilityState === 'visible') load()
    }
    document.addEventListener('visibilitychange', onVis)

    return () => {
      mountedRef.current = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [load])

  const anyMocked = Boolean(
    status && ((status.battery && status.battery.mocked) || (status.storage && status.storage.mocked))
  )
  useEffect(() => {
    if (!anyMocked) setDismissed(false)
  }, [anyMocked])

  const refresh = async () => {
    const ok = await load()
    if (!ok && mountedRef.current) setOffline(true)
  }

  if (loading) {
    return (
      <div className="st-panel">
        <div className="st-toolbar" aria-hidden="true">
          <div>
            <div className="skeleton st-sk-title" />
            <div className="skeleton st-sk-sub" />
          </div>
          <div className="skeleton st-sk-btn" />
        </div>
        <div className="st-grid" aria-hidden="true">
          <div className="st-card glass">
            <div className="skeleton st-sk-line" style={{ width: 84 }} />
            <div className="st-batt">
              <div className="skeleton st-sk-circle" />
              <div className="st-batt-meta">
                <div className="skeleton st-sk-line" style={{ width: 96 }} />
                <div className="skeleton st-sk-line" style={{ width: 64 }} />
              </div>
            </div>
          </div>
          {[0, 1, 2].map((i) => (
            <div key={i} className="st-card glass">
              <div className="skeleton st-sk-line" style={{ width: 84 }} />
              <div className="skeleton st-sk-big" style={{ width: i === 1 ? 130 : 160 }} />
              <div className="skeleton st-sk-line" style={{ width: '70%' }} />
              <div className="skeleton st-sk-line" style={{ width: '55%' }} />
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (!status) {
    return (
      <div className="st-panel">
        <div className="st-toolbar">
          <div>
            <div className="st-title">System overview</div>
            <div className="st-subtitle muted">Live health of your pocket cloud</div>
          </div>
          <button className="btn iconbtn" onClick={refresh} aria-label="Refresh status" title="Refresh">
            <Icon name="refresh" size={16} />
          </button>
        </div>
        <div className="empty">
          <div className="btn iconbtn" aria-hidden="true">
            <Icon name="wifi" size={22} />
          </div>
          Status unavailable — the server did not respond.
          <div>
            <button className="btn btn-primary st-retry" onClick={refresh}>
              Try again
            </button>
          </div>
        </div>
      </div>
    )
  }

  const battery = status.battery || {}
  const storage = status.storage || {}
  const device = status.device || {}
  const tunnel = status.tunnel || {}
  const level = typeof battery.level === 'number' && Number.isFinite(battery.level) ? battery.level : null
  const low = level != null && level < 20
  const temp =
    typeof battery.temperature === 'number' && Number.isFinite(battery.temperature)
      ? battery.temperature
      : null
  const usedPct =
    typeof storage.usedPct === 'number' && Number.isFinite(storage.usedPct) ? storage.usedPct : null
  const barPct = usedPct == null ? 0 : Math.max(0, Math.min(100, usedPct))

  return (
    <div className="st-panel">
      <div className="st-toolbar">
        <div>
          <div className="st-title">System overview</div>
          <div className="st-subtitle muted">Live health of your pocket cloud</div>
        </div>
        <button className="btn iconbtn" onClick={refresh} aria-label="Refresh status" title="Refresh">
          <Icon name="refresh" size={16} />
        </button>
      </div>

      {anyMocked && !dismissed && (
        <div className="banner" role="status">
          <Icon name="alert" size={15} />
          <span>Termux not detected — showing demo data.</span>
          <button
            className="btn iconbtn"
            onClick={() => setDismissed(true)}
            aria-label="Dismiss notice"
            title="Dismiss"
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      )}

      {offline && (
        <div className="st-offline" role="status">
          <Icon name="alert" size={14} />
          <span>Can't reach the server — showing the last known values.</span>
        </div>
      )}

      <div className="st-grid">
        <section className="st-card glass" aria-label="Battery">
          <CardHead
            icon="bolt"
            label="Battery"
            mocked={battery.mocked}
            light={!battery.charging && level != null && level < 30}
          />
          <div className="st-batt">
            <RingGauge
              level={level}
              low={low}
              label={
                'Battery ' +
                (level == null ? 'unknown' : Math.round(level) + ' percent') +
                (battery.charging ? ', charging' : '')
              }
            />
            <div className="st-batt-meta">
              <div className={'st-batt-state ' + (battery.charging ? 'is-charging' : 'is-onbatt')}>
                <Icon name="bolt" size={15} />
                {battery.charging ? 'Charging' : 'On battery'}
              </div>
              {temp != null && <div className="st-batt-temp muted">{temp.toFixed(1)}°C</div>}
            </div>
          </div>
        </section>

        <section className="st-card glass" aria-label="Storage">
          <CardHead icon="cloud" label="Storage" mocked={storage.mocked} />
          <div className="st-storage-num">
            {usedPct != null ? Math.round(usedPct) + '%' : '—'}
            <span className="st-storage-cap">used</span>
          </div>
          <div
            className="st-bar"
            {...(usedPct != null
              ? {
                  role: 'progressbar',
                  'aria-label': 'Storage used',
                  'aria-valuemin': 0,
                  'aria-valuemax': 100,
                  'aria-valuenow': Math.round(usedPct)
                }
              : {})}
          >
            <div className="st-bar-fill" style={{ width: barPct + '%' }} />
          </div>
          <div className="st-storage-label muted">
            {storage.total != null && storage.free != null
              ? humanizeBytes(storage.free) + ' free of ' + humanizeBytes(storage.total)
              : 'Capacity information unavailable'}
          </div>
        </section>

        <section className="st-card glass" aria-label="Device">
          <CardHead icon="cpu" label="Device" />
          <div className="st-big">
            {device.termux ? 'Server' : 'Demo mode' + (device.platform ? ' · ' + device.platform : '')}
          </div>
          <div className="st-kvs">
            <div className="st-kv">
              <span className="muted">Uptime</span>
              <span>{humanizeUptime(status.uptimeSec)}</span>
            </div>
            {device.termux && device.platform && (
              <div className="st-kv">
                <span className="muted">Platform</span>
                <span>{device.platform}</span>
              </div>
            )}
            {status.version && (
              <div className="st-kv">
                <span className="muted">Version</span>
                <span>{status.version}</span>
              </div>
            )}
          </div>
          {device.termux && (
            <div className="st-chips">
              <span className="chip chip-ok">Termux detected</span>
            </div>
          )}
        </section>

        <section className="st-card glass" aria-label="Access">
          <CardHead icon={tunnel.mode === 'lan' ? 'wifi' : 'shield'} label="Access" />
          <div className="st-big">{TUNNEL_LABELS[tunnel.mode] || tunnel.mode || 'Unknown'}</div>
          {tunnel.hint && <div className="st-hint muted">{tunnel.hint}</div>}
          <div className="st-chips">
            {tunnel.mode === 'lan' && <span className="chip">Direct LAN</span>}
            {tunnel.mode === 'tailscale' && <span className="chip chip-ok">Private mesh</span>}
            {tunnel.mode === 'cloudflared' && <span className="chip chip-ok">Secure tunnel</span>}
          </div>
        </section>
      </div>
    </div>
  )
}
