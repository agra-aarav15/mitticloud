import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../icons.jsx'
import {
  fetchStatus,
  fetchPhotos,
  fetchAgentSessions,
  fetchTasks,
  createAgentSession,
  sendAgentMessage,
  fetchCliStatus,
  humanizeBytes,
  humanizeUptime,
  timeAgo,
  toast
} from '../api.js'
import './HomePanel.css'

// The start screen: calm premium hero that ticks live, ONE command box that
// answers cloud questions instantly (real numbers only) and hands everything
// else to the agent, your real stuff, and a guide that disappears as you finish.
// Deliberately light — no canvas, no blur walls, nothing an old phone feels.

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

// Instant answers: the cloud speaks with real data it already has. Anything
// that is not a known question goes to the agent — no pretending.
function buildAnswer(q, data) {
  const t = q.toLowerCase()
  const has = (...ws) => ws.some((w) => t.includes(w))
  const { status, sites, photoCount, taskCount, uptimeSec } = data
  const lines = []
  let tab = null
  if (has('battery', 'power', 'charging')) {
    const b = (status && status.battery) || {}
    lines.push(
      b.present === false
        ? 'No battery here — it runs on AC power, always on, never sleeping.'
        : b.charging
          ? 'Charging right now — heavy jobs are allowed.'
          : b.level != null
            ? 'On battery at ' + Math.round(b.level) + '%. Heavy jobs wait below 30%.'
            : 'On battery — heavy jobs wait below 30%.'
    )
    tab = 'status'
  } else if (has('storage', 'disk', 'space')) {
    const s = (status && status.storage) || {}
    if (s.free != null && s.total != null) {
      lines.push(
        humanizeBytes(s.free) + ' free of ' + humanizeBytes(s.total) + ' on this device.'
      )
      tab = 'status'
    } else {
      return null
    }
  } else if (has('uptime', 'how long', 'awake', 'running since')) {
    lines.push('Awake and serving for ' + humanizeUptime(uptimeSec) + '.')
    tab = 'status'
  } else if (has('site', 'host', 'website', 'domain', 'url')) {
    if (sites.length) {
      lines.push(
        sites.length + (sites.length === 1 ? ' site' : ' sites') + ' live from this cloud: ' +
          sites.map((s) => s.name).join(', ') + '.'
      )
    } else {
      lines.push('No sites hosted yet — upload a folder in Host and it is live in seconds.')
    }
    tab = 'host'
  } else if (has('photo', 'vault', 'gallery')) {
    lines.push(
      photoCount > 0
        ? photoCount + (photoCount === 1 ? ' photo' : ' photos') + ' safe in the vault.'
        : 'The vault is empty — upload your first memories and they live on your phone.'
    )
    tab = 'photos'
  } else if (has('automat', 'task', 'schedule', 'cron')) {
    lines.push(
      taskCount > 0
        ? taskCount + (taskCount === 1 ? ' automation' : ' automations') + ' running on schedule.'
        : 'No automations yet — one tap turns on a nightly health check.'
    )
    tab = 'status'
  } else if (has('help', 'what can', 'how do', 'guide', 'start')) {
    lines.push('Ask about your cloud: "my sites", "storage", "battery", "uptime", "photos", "automations".')
    lines.push('Anything bigger — "clean up my downloads", "write a page", "watch a file" — goes straight to your agent.')
  } else {
    return null
  }
  return { lines, tab }
}

const TAB_LABELS = { status: 'Status', host: 'Host', photos: 'Photos' }

// words that make a question a cloud-question — those must never fall through
// to the agent just because the numbers were still loading
const CLOUD_RE =
  /(battery|power|charging|storage|disk|space|uptime|how long|awake|running since|site|host|website|domain|url|photo|vault|gallery|automat|task|schedule|cron|help|what can|how do|guide|start)/

export default function HomePanel({ onGoTo }) {
  const [status, setStatus] = useState(null)
  const [statusAt, setStatusAt] = useState(0)
  const [sites, setSites] = useState([])
  const [photoCount, setPhotoCount] = useState(null)
  const [taskCount, setTaskCount] = useState(null)
  const [lastSession, setLastSession] = useState(null)
  const [lastSite, setLastSite] = useState(null)
  const [job, setJob] = useState('')
  const [busy, setBusy] = useState(false)
  const [answer, setAnswer] = useState(null)
  const [, setTick] = useState(0)

  // the hero ticks every second — the cloud visibly never sleeps
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000)
    return () => clearInterval(t)
  }, [])

  const load = useCallback(async () => {
    let st = null
    let siteList = []
    let photoCt = null
    let taskCt = 0
    try {
      st = await fetchStatus()
      setStatus(st)
      setStatusAt(Date.now())
    } catch {
      /* the sentence simply stays short */
    }
    try {
      const d = await fetch('/api/sites').then((r) => r.json())
      siteList = d.sites || []
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
      photoCt = Array.isArray(photos) ? photos.length : null
      setPhotoCount(photoCt)
    } catch {
      /* skip */
    }
    try {
      const tasks = await fetchTasks()
      taskCt = Array.isArray(tasks) ? tasks.length : 0
      setTaskCount(taskCt)
    } catch {
      /* skip */
    }
    try {
      const sessions = await fetchAgentSessions()
      if (sessions.length) setLastSession(sessions[0])
    } catch {
      /* skip */
    }
    return { status: st, sites: siteList, photoCount: photoCt, taskCount: taskCt }
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

  async function sendJob(textArg) {
    const t = (textArg ?? job).trim()
    if (!t || busy) return
    let data = { status, sites, photoCount, taskCount, uptimeSec }
    let instant = buildAnswer(t, data)
    if (!instant && CLOUD_RE.test(t.toLowerCase())) {
      // the question is about the cloud but the numbers were still arriving —
      // measure for real, then answer
      const fresh = await load()
      data = {
        ...fresh,
        uptimeSec: fresh.status ? Math.max(0, fresh.status.uptimeSec || 0) : 0
      }
      instant = buildAnswer(t, data)
    }
    if (instant) {
      setAnswer({ q: t, ...instant })
      setJob('')
      return
    }
    setBusy(true)
    try {
      const sessions = await fetchAgentSessions()
      let s = sessions[0]
      if (!s) {
        let preset = null
        try {
          const cli = await fetchCliStatus()
          preset = (cli.presets || []).find((p) => p.installed && p.id !== 'custom') || null
        } catch {
          /* fall through to the API brain */
        }
        s = preset
          ? await createAgentSession({ engine: 'cli', cliCmd: preset.cmd, cliLabel: preset.label, workspace: '.' })
          : await createAgentSession({ providerId: 'gemini', workspace: '.' })
      }
      const out = await sendAgentMessage(s.id, t)
      if (out.batteryMode) toast(out.message, 'info')
      onGoTo('remote')
    } catch (err) {
      toast(err.message, 'err')
      toast('Set up an agent brain once — it is waiting in Remote.', 'info')
      onGoTo('remote')
    } finally {
      setBusy(false)
    }
  }

  const steps = [
    { label: 'Host your first site', done: sites.length > 0, tab: 'host' },
    { label: 'Turn on an automation', done: (taskCount || 0) > 0, tab: 'status' },
    { label: 'Pair ZCode remote', done: zcodePaired(), tab: 'remote' }
  ]
  const pendingSteps = steps.filter((s) => !s.done)
  const showTries = !answer && !job.trim()

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

      <div className="hm-command glass">
        <input
          className="hm-input"
          placeholder="Give your cloud a job — it runs for real"
          value={job}
          disabled={busy}
          onChange={(e) => setJob(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') sendJob()
          }}
          aria-label="Give the agent a job"
        />
        <button className="btn btn-primary hm-go" disabled={busy || !job.trim()} onClick={sendJob}>
          {busy && <span className="spin" aria-hidden="true" />}
          {busy ? 'Running…' : 'Run it'}
          {!busy && <Icon name="arrowRight" size={15} />}
        </button>
      </div>

      {showTries && (
        <div className="hm-tries muted">
          <span>try:</span>
          {['my sites', 'storage', 'battery', 'uptime'].map((t) => (
            <button key={t} className="hm-try" onClick={() => sendJob(t)}>
              {t}
            </button>
          ))}
        </div>
      )}

      {answer && (
        <div className="hm-answer glass" role="status">
          <div className="hm-answer-q muted">{answer.q}</div>
          {answer.lines.map((l, i) => (
            <div key={i} className="hm-answer-line">
              {l}
            </div>
          ))}
          <div className="hm-answer-actions">
            {answer.tab && (
              <button className="btn" onClick={() => onGoTo(answer.tab)}>
                Open {TAB_LABELS[answer.tab] || answer.tab} <Icon name="arrowRight" size={14} />
              </button>
            )}
            <button className="btn" onClick={() => setAnswer(null)}>
              Close
            </button>
          </div>
        </div>
      )}

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
            {sites.length > 0 ? sites.length + ' hosted here' : 'LAN, Cloudflare, your domain'}
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
