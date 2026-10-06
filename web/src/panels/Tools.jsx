import React, { useEffect, useRef, useState } from 'react'
import { Icon } from '../icons.jsx'
import { toast, copyText, fetchHostLan, fetchTunnel, startQuickTunnel, startTokenTunnel, stopTunnel, runLoadTest } from '../api.js'

// Tools — everything secondary lives here so the cards above stay the story:
// LAN links, the tunnels, and the load test, all under one Advanced roof.
export default function Tools({ sites }) {
  const [lan, setLan] = useState(null)
  const [tunnel, setTunnel] = useState(null)
  const [site, setSite] = useState('')
  const [token, setToken] = useState('')
  const [bin, setBin] = useState('')
  const [busy, setBusy] = useState(false)
  const [load, setLoad] = useState(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    fetchHostLan()
      .then((d) => alive.current && setLan({ ...d, failed: false }))
      .catch(() => alive.current && setLan({ urls: [], failed: true }))
    fetchTunnel()
      .then((d) => alive.current && setTunnel(d))
      .catch(() => {})
    return () => {
      alive.current = false
    }
  }, [])

  const tunnelRunning = tunnel && tunnel.running
  useEffect(() => {
    if (!tunnelRunning) return
    const t = setInterval(() => fetchTunnel().then((d) => alive.current && setTunnel(d)).catch(() => {}), 2500)
    return () => clearInterval(t)
  }, [tunnelRunning])

  useEffect(() => {
    if (!site && sites && sites.length > 0) setSite(sites[0].name)
  }, [sites, site])

  const sitePath = site ? '/s/' + site + '/' : '/'

  const copy = async (text, label) => {
    const ok = await copyText(text)
    toast(ok ? label + ' copied' : "Couldn't copy — select the text and copy it manually", ok ? 'ok' : 'info')
  }

  const doQuick = async () => {
    setBusy(true)
    try {
      const d = await startQuickTunnel(bin.trim() || undefined)
      setTunnel(d)
      if (d.url) toast('Public URL is live', 'ok')
      else if (d.failed || d.exitCode !== undefined)
        toast('cloudflared could not start — is it installed and on PATH?', 'err')
      else toast('cloudflared is starting — the URL appears in a few seconds', 'info')
    } catch (err) {
      toast(err.message, 'err')
    } finally {
      setBusy(false)
    }
  }

  const doToken = async () => {
    setBusy(true)
    try {
      const d = await startTokenTunnel(token.trim(), bin.trim() || undefined)
      setTunnel(d)
      setToken('')
      if (d.running) toast('Token tunnel running — your dashboard hostname now points here', 'ok')
      else toast('cloudflared exited — check the log below (bad token or missing binary)', 'err')
    } catch (err) {
      toast(err.message, 'err')
    } finally {
      setBusy(false)
    }
  }

  const doStop = async () => {
    setBusy(true)
    try {
      setTunnel(await stopTunnel())
      toast('Tunnel stopped', 'ok')
    } catch (err) {
      toast(err.message, 'err')
    } finally {
      setBusy(false)
    }
  }

  const doLoad = async () => {
    setBusy(true)
    setLoad(null)
    try {
      setLoad(await runLoadTest({ visitors: 200, seconds: 15, path: sitePath }))
    } catch (err) {
      toast(err.message, 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="hs-block">
      <div className="hs-label muted">Tools</div>
      <div className="golive glass">
        {sites && sites.length > 0 ? (
          <select className="golive-site" value={site} onChange={(e) => setSite(e.target.value)} aria-label="Site for these tools">
            {sites.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
          </select>
        ) : (
          <p className="muted golive-note">Publish a website first — then the LAN links and tools live here.</p>
        )}

        <div className="hs-btnrow hs-lan-row">
          {lan &&
            lan.urls.map((u) => (
              <button key={u} className="golive-url" onClick={() => copy(u + sitePath, 'LAN URL')}>
                <span>{u + sitePath}</span>
                <Icon name="copy" size={13} />
              </button>
            ))}
          {!lan && <span className="muted">reading network…</span>}
          {lan && lan.failed && (
            <p className="muted golive-err">
              Couldn't read the network addresses.{' '}
              <button
                className="golive-retry"
                onClick={() =>
                  fetchHostLan()
                    .then((d) => setLan({ ...d, failed: false }))
                    .catch(() => setLan({ urls: [], failed: true }))
                }
              >
                Retry
              </button>
            </p>
          )}
        </div>

        <details className="golive-help">
          <summary className="muted">Advanced — public URL (tunnel) and load test</summary>

          <div className="hs-btnrow">
            <button className="btn" disabled={busy || tunnelRunning} onClick={doQuick}>
              <Icon name="cloud" size={15} /> Quick public URL (temporary)
            </button>
          </div>
          <div className="hs-btnrow">
            <input
              type="password"
              autoComplete="off"
              placeholder="Tunnel token (24/7, own hostname)"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <button className="btn" disabled={busy || !token.trim() || tunnelRunning} onClick={doToken}>
              Run token tunnel
            </button>
          </div>
          {tunnel && tunnel.running && (
            <div className="golive-status">
              {tunnel.mode === 'quick' && tunnel.url ? (
                <button className="golive-url live" onClick={() => copy(tunnel.url, 'Public URL')}>
                  <span>{tunnel.url}</span>
                  <Icon name="copy" size={13} />
                </button>
              ) : tunnel.mode === 'quick' ? (
                <span className="muted">
                  Requesting a public URL from Cloudflare…
                  {tunnel.log && tunnel.log.length > 0 && (
                    <span className="golive-err"> {tunnel.log[tunnel.log.length - 1]}</span>
                  )}
                </span>
              ) : (
                <span className="golive-live-chip">TUNNEL RUNNING</span>
              )}
              <span className="muted">
                {tunnel.mode === 'token'
                  ? 'Cloudflare routes your hostname to this phone 24/7 — reach the dashboard and every site from anywhere.'
                  : 'Temporary URL — for your own domain, publish the site to Cloudflare on its card.'}
              </span>
              <button className="btn btn-danger" onClick={doStop} disabled={busy}>
                Stop
              </button>
            </div>
          )}
          {tunnel && !tunnel.running && tunnel.log && tunnel.log.length > 0 && (
            <p className="muted golive-err">cloudflared exited — {tunnel.log[tunnel.log.length - 1]}</p>
          )}
          <p className="muted">
            cloudflared is Cloudflare's free connector. Download the Windows exe from
            github.com/cloudflare/cloudflared/releases (cloudflared-windows-amd64.exe) and either
            add it to PATH or paste its full path below.
          </p>
          <div className="hs-btnrow">
            <input
              placeholder="Path to cloudflared (optional — blank = from PATH)"
              value={bin}
              onChange={(e) => setBin(e.target.value)}
            />
          </div>

          <div className="hs-btnrow">
            <button className="btn" disabled={busy} onClick={doLoad}>
              {busy ? <span className="spin" aria-hidden="true" /> : <Icon name="bolt" size={14} />}
              {busy ? 'Firing visitors…' : 'Load test — send 200 visitors'}
            </button>
          </div>
          {load && (
            <div className="golive-load">
              <span className="chip chip-ok">{load.requests} requests served</span>
              <span className="chip">{load.rps} req/s</span>
              <span className="chip">p50 {load.p50Ms} ms</span>
              <span className="chip">p95 {load.p95Ms} ms</span>
              <span className={'chip ' + (load.errors === 0 ? 'chip-ok' : 'chip-warn')}>
                {load.errors} failed
              </span>
              {load.note && <p className="muted golive-note">{load.note}</p>}
            </div>
          )}
        </details>
      </div>
    </section>
  )
}
