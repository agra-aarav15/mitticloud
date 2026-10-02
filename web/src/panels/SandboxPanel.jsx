import React, { useEffect, useRef, useState } from 'react'
import { Icon } from '../icons.jsx'
import { runSandbox, toast } from '../api.js'
import './SandboxPanel.css'

const STORE_KEY = 'mitticloud.sandbox.v1'
const LANGS = [
  { id: 'js', label: 'js' },
  { id: 'python', label: 'python' }
]

function loadStore() {
  try {
    const d = JSON.parse(localStorage.getItem(STORE_KEY) || 'null')
    return {
      code: d && typeof d.code === 'string' ? d.code : '',
      language: d && d.language === 'python' ? 'python' : 'js'
    }
  } catch {
    return { code: '', language: 'js' }
  }
}

export default function SandboxPanel() {
  const [initial] = useState(loadStore)
  const [code, setCode] = useState(initial.code)
  const [language, setLanguage] = useState(initial.language)
  const [result, setResult] = useState(null)
  const [gate, setGate] = useState(null) // battery-mode gate from the server
  const [running, setRunning] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const persistT = useRef(null)

  // Persist code + language (debounced) so the snippet survives reloads.
  useEffect(() => {
    clearTimeout(persistT.current)
    persistT.current = setTimeout(() => {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify({ code, language }))
      } catch {
        // storage full/blocked — not worth surfacing
      }
    }, 300)
    return () => clearTimeout(persistT.current)
  }, [code, language])

  const run = async (confirm = false) => {
    if (running) return
    if (!code.trim()) {
      toast('Write a snippet to run first', 'info')
      return
    }
    setRunning(true)
    setGate(null)
    setResult(null)
    setElapsed(0)
    const started = performance.now()
    const timer = setInterval(() => setElapsed(Math.round(performance.now() - started)), 100)
    try {
      const d = await runSandbox(language, code, confirm)
      if (d && d.batteryMode) setGate(d)
      else setResult(d)
    } catch (e) {
      toast(e.message || 'Run failed', 'err')
    } finally {
      clearInterval(timer)
      setRunning(false)
    }
  }

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      run()
    }
  }

  const clear = () => {
    setResult(null)
    setGate(null)
  }

  return (
    <div className="sb-panel">
      <div className="sb-toolbar">
        <div>
          <div className="sb-title">Sandbox</div>
          <div className="sb-subtitle muted">Run quick snippets on the phone itself</div>
        </div>
        <div className="sb-langs" role="group" aria-label="Language">
          {LANGS.map((l) => (
            <button
              key={l.id}
              type="button"
              className={'sb-lang' + (language === l.id ? ' active' : '')}
              aria-pressed={language === l.id}
              onClick={() => setLanguage(l.id)}
            >
              {l.label}
            </button>
          ))}
        </div>
      </div>

      {gate && (
        <div className="banner sb-banner" role="status">
          <Icon name="alert" size={15} />
          <span className="sb-banner-msg">{gate.message}</span>
          <button className="btn sb-banner-btn" onClick={() => run(true)}>
            Run anyway
          </button>
          <button
            className="btn iconbtn"
            onClick={() => setGate(null)}
            aria-label="Dismiss warning"
            title="Dismiss"
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      )}

      <section className="sb-editor glass">
        <textarea
          className="sb-code"
          id="sb-code"
          name="code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="console.log('hello from your pocket cloud')"
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          aria-label="Code"
        />
        <div className="sb-actions">
          <span className="sb-hint muted">Ctrl+Enter to run</span>
          <div className="sb-actions-r">
            <button className="btn" onClick={clear} disabled={running || (!result && !gate)}>
              Clear
            </button>
            <button className="btn btn-primary" onClick={() => run()} disabled={running}>
              {running ? 'Running · ' + elapsed + ' ms' : 'Run'}
            </button>
          </div>
        </div>
      </section>

      {result ? (
        <section className="sb-output glass" aria-live="polite">
          <div className="sb-out-head">
            <span className="sb-overline">Output</span>
            <span className="sb-out-meta muted">
              {result.durationMs} ms{result.timedOut ? ' · timed out' : ''}
            </span>
          </div>
          {result.timedOut && (
            <div className="sb-timeout" role="status">
              Timed out after 5s — the process was killed.
            </div>
          )}
          {result.stdout ? (
            <pre className="sb-pre">{result.stdout}</pre>
          ) : (
            <pre className="sb-pre sb-pre-empty muted">(no stdout)</pre>
          )}
          {result.stderr ? <pre className="sb-pre sb-err">{result.stderr}</pre> : null}
        </section>
      ) : (
        <div className="empty">
          <div className="btn iconbtn" aria-hidden="true">
            <Icon name="cpu" size={22} />
          </div>
          {running
            ? 'Running on the server…'
            : 'Nothing has run yet — write a snippet above and press Run.'}
        </div>
      )}
    </div>
  )
}
