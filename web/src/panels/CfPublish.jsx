import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../icons.jsx'
import { toast, copyText, fetchCfStatus, saveCfToken, clearCfToken, publishCfSite } from '../api.js'

// Per-site Cloudflare publish — lives on each website card now, not in a
// wizard. Connect once (token stored on this device only), then publishing
// any site is one tap. Custom domains stay a Cloudflare-dashboard step; the
// result line says exactly where to tap.
export default function CfPublish({ site }) {
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
      .catch((err) => {
        if (!alive.current) return
        setCf({ connected: false, error: err.message || 'status unavailable' })
      })
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
    const ok = await copyText(text)
    toast(ok ? label + ' copied' : "Couldn't copy — select the text and copy it manually", ok ? 'ok' : 'info')
  }

  if (cf === null) return <span className="muted hs-cf">Cloudflare…</span>

  if (!cf.connected) {
    return (
      <details className="hs-cf">
        <summary className="btn">
          <Icon name="cloud" size={13} /> Publish to Cloudflare
        </summary>
        <div className="hs-cf-body">
          <p className="muted">
            Puts this site on Cloudflare Pages — your own domain, free forever, never sleeps. You
            need an API token with <b>Cloudflare Pages: Edit</b> permission (dash.cloudflare.com →
            My Profile → API Tokens → Create Token).
          </p>
          <div className="hs-btnrow">
            <input
              type="password"
              autoComplete="off"
              placeholder="Paste your Cloudflare API token"
              value={tokenDraft}
              onChange={(e) => setTokenDraft(e.target.value)}
            />
            <button className="btn btn-primary" disabled={busy || !tokenDraft.trim()} onClick={connect}>
              {busy && <span className="spin" aria-hidden="true" />}
              Connect
            </button>
          </div>
          {cf.error && (
            <p className="muted hs-cf-err">
              Couldn't read Cloudflare status — {cf.error}. <button className="tools-retry" onClick={refresh}>Retry</button>
            </p>
          )}
        </div>
      </details>
    )
  }

  const accounts = cf.accounts || []
  return (
    <div className="hs-cf">
      {accounts.length > 1 ? (
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)} aria-label="Cloudflare account">
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      ) : (
        accounts[0] && <span className="chip">{accounts[0].name}</span>
      )}
      <button className="btn btn-primary" disabled={busy || !site} onClick={publish}>
        <Icon name="cloud" size={14} /> {busy ? 'Publishing…' : 'Publish'}
      </button>
      <button className="btn" disabled={busy} onClick={disconnect} title="Forget the stored token">
        Disconnect
      </button>
      {result && (
        <div className="hs-cf-result">
          <button className="tools-url live" onClick={() => copy(result.url, 'Live URL')}>
            <span>{result.url}</span>
            <Icon name="copy" size={13} />
          </button>
          <span className="muted">
            {result.files} files published
            {result.uploaded === 0 ? ' — nothing new, Cloudflare reused every file' : ''}. For your
            own domain: Cloudflare dashboard → Pages → this project → Custom domains → add it once.
          </span>
        </div>
      )}
    </div>
  )
}
