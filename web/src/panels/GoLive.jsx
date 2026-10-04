import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../icons.jsx'
import { toast } from '../api.js'
import {
  fetchHostLan,
  fetchTunnel,
  startQuickTunnel,
  startTokenTunnel,
  stopTunnel,
  runLoadTest,
  fetchCfStatus,
  saveCfToken,
  clearCfToken,
  publishCfSite
} from '../api.js'

// Go live — the cfn experience, in-app:
// 1. TEST ON LAN      the site is reachable from every device on the Wi-Fi
// 2. PUBLISH          Cloudflare Pages on the user's OWN domain (cfnkurties-style:
//                     free forever, never sleeps) or a quick tunnel for previews
// 3. PROVE IT         throw 200 visitors at the site and show the real numbers

const CLOUDFLARED_HELP =
  'cloudflared is Cloudflare\'s free connector. Download the Windows exe from github.com/cloudflare/cloudflared/releases (cloudflared-windows-amd64.exe) and either add it to PATH or paste its full path below.'

function CloudflareStep({ sites, site }) {
  const [cf, setCf] = useState(null) // {connected, accounts?, error?}
  const [tokenDraft, setTokenDraft] = useState('')
  const [accountId, setAccountId] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const alive = useRef(true)

  const refresh = useCallback(() => {
    fetchCfStatus()
      .then((d) => {
        if (!alive.current) return
        setCf(d)
        if (d.connected && d.accounts && d.accounts.length) {
          setAccountId((cur) => cur || d.accounts[0].id)
        }
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    alive.current = true
    refresh()
    return () => {
      alive.current = false
    }
  }, [refresh])

  const connect = async () => {
    setBusy(true)
    try {
      const d = await saveCfToken(tokenDraft.trim())
      setCf({ connected: true, accounts: d.accounts || [] })
      if (d.accounts && d.accounts.length) setAccountId(d.accounts[0].id)
      setTokenDraft('')
      toast('Cloudflare connected — token stored on this device only', 'ok')
    } catch (err) {
      toast(err.message, 'err')
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async () => {
    try {
      await clearCfToken()
      setCf({ connected: false })
      toast('Cloudflare disconnected', 'ok')
    } catch (err) {
      toast(err.message, 'err')
    }
  }

  const publish = async () => {
    setBusy(true)
    setResult(null)
    try {
      const d = await publishCfSite(site, accountId)
      setResult(d)
      toast('Site is live on Cloudflare', 'ok')
    } catch (err) {
      toast(err.message, 'err')
    } finally {
      setBusy(false)
    }
  }

  const copy = async (text, label) => {
    try {
      await navigator.clipboard.writeText(text)
      toast(label + ' copied', 'ok')
    } catch {
      toast('Could not copy', 'err')
    }
  }

  if (cf === null) return <span className="muted">Checking Cloudflare…</span>

  if (!cf.connected) {
    return (
      <div className="cf-connect">
        <p className="muted">
          This puts your site on Cloudflare Pages — your own domain, free forever, never sleeps.
          That is how your CFN store runs. You need an API token with the <b>Cloudflare Pages:
          Edit</b> permission (dash.cloudflare.com → My Profile → API Tokens → Create Token).
        </p>
        <div className="golive-btnrow">
          <input
            type="password"
            autoComplete="off"
            placeholder="Paste your Cloudflare API token"
            value={tokenDraft}
            onChange={(e) => setTokenDraft(e.target.value)}
          />
          <button className="btn btn-primary" disabled={busy || !tokenDraft.trim()} onClick={connect}>
            Connect
          </button>
        </div>
        {cf.error && <p className="muted golive-err">Last attempt failed — {cf.error}</p>}
      </div>
    )
  }

  const accounts = cf.accounts || []
  return (
    <div className="cf-connect">
      {accounts.length > 1 ? (
        <select className="golive-site" value={accountId} onChange={(e) => setAccountId(e.target.value)} aria-label="Cloudflare account">
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      ) : (
        accounts[0] && <span className="chip">{accounts[0].name}</span>
      )}
      <div className="golive-btnrow">
        <button className="btn btn-primary" disabled={busy || !site} onClick={publish}>
          <Icon name="cloud" size={15} /> {busy ? 'Publishing…' : 'Publish to Cloudflare'}
        </button>
        <button className="btn" disabled={busy} onClick={disconnect}>
          Disconnect
        </button>
      </div>
      {result && (
        <div className="golive-status">
          <button className="golive-url live" onClick={() => copy(result.url, 'Live URL')}>
            <span>{result.url}</span>
            <Icon name="copy" size={13} />
          </button>
          <span className="muted">
            {result.files} files published
            {result.uploaded === 0 ? ' — nothing new to upload, Cloudflare reused every file' : ''}
            . Your own domain: Cloudflare dashboard → Pages → this project → Custom domains → add
            it once; it stays on your domain 24/7.
          </span>
        </div>
      )}
      {sites && sites.length === 0 && <p className="muted golive-note">Upload a site above first.</p>}
    </div>
  )
}

export default function GoLive({ sites }) {
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
    fetchHostLan().then((d) => alive.current && setLan(d)).catch(() => {})
    fetchTunnel().then((d) => alive.current && setTunnel(d)).catch(() => {})
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
    try {
      await navigator.clipboard.writeText(text)
      toast(label + ' copied', 'ok')
    } catch {
      toast('Could not copy', 'err')
    }
  }

  const doQuick = async () => {
    setBusy(true)
    try {
      const d = await startQuickTunnel(bin.trim() || undefined)
      setTunnel(d)
      if (d.url) toast('Public URL is live', 'ok')
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
      toast('Token tunnel running — your dashboard hostname now points here', 'ok')
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
      <div className="hs-label muted">Take a site live</div>
      <div className="golive glass">
        {sites && sites.length > 0 ? (
          <select className="golive-site" value={site} onChange={(e) => setSite(e.target.value)} aria-label="Site to take live">
            {sites.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
          </select>
        ) : (
          <p className="muted golive-note">Upload a site above first — then test it on your LAN and take it public.</p>
        )}

        <div className="golive-steps">
          <div className="golive-step">
            <div className="golive-step-head">
              <span className="golive-num">1</span>
              <span className="golive-title">Test on LAN</span>
            </div>
            <p className="muted">Open these from any device on the same Wi-Fi. Nothing leaves your network.</p>
            {lan &&
              lan.urls.map((u) => (
                <button key={u} className="golive-url" onClick={() => copy(u + sitePath, 'LAN URL')}>
                  <span>{u + sitePath}</span>
                  <Icon name="copy" size={13} />
                </button>
              ))}
            {!lan && <span className="muted">reading network…</span>}
          </div>

          <div className="golive-step">
            <div className="golive-step-head">
              <span className="golive-num">2</span>
              <span className="golive-title">Publish to Cloudflare</span>
            </div>
            <CloudflareStep sites={sites} site={site} />
            <details className="golive-help">
              <summary className="muted">Just need a quick preview link (temporary)?</summary>
              <div className="golive-btnrow">
                <button className="btn" disabled={busy || tunnelRunning} onClick={doQuick}>
                  <Icon name="cloud" size={15} /> Quick public URL
                </button>
              </div>
              <div className="golive-btnrow">
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
                    <span className="muted">Requesting a public URL from Cloudflare…</span>
                  ) : (
                    <span className="golive-live-chip">TUNNEL RUNNING</span>
                  )}
                  <span className="muted">
                    {tunnel.mode === 'token'
                      ? 'Cloudflare routes your hostname to this phone 24/7.'
                      : 'Temporary URL — use Publish for your real domain.'}
                  </span>
                  <button className="btn btn-danger" onClick={doStop} disabled={busy}>
                    Stop
                  </button>
                </div>
              )}
              {tunnel && !tunnel.running && tunnel.log && tunnel.log.length > 0 && (
                <p className="muted golive-err">cloudflared exited — {tunnel.log[tunnel.log.length - 1]}</p>
              )}
              <p className="muted">{CLOUDFLARED_HELP}</p>
              <input
                placeholder="Path to cloudflared (optional — blank = from PATH)"
                value={bin}
                onChange={(e) => setBin(e.target.value)}
              />
            </details>
          </div>

          <div className="golive-step">
            <div className="golive-step-head">
              <span className="golive-num">3</span>
              <span className="golive-title">Prove it — 200 visitors</span>
            </div>
            <p className="muted">
              Fires 200 concurrent visitors at the site for 15 seconds and reports the real numbers.
              Measured on this device; real visitors add only their own Wi-Fi hop.
            </p>
            <button className="btn btn-primary" disabled={busy} onClick={doLoad}>
              <Icon name="bolt" size={15} /> Send 200 visitors
            </button>
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
          </div>
        </div>
      </div>
    </section>
  )
}
