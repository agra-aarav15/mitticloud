import React, { useEffect, useRef, useState } from 'react'
import { Icon } from '../icons.jsx'
import { fetchFileContent, saveFileContent, toast } from '../api.js'
import './CodeEditor.css'

// ONE code editor, two doors: the Files tab opens it for any text file in the
// vault, and each hosted app opens it on its own files. Monochrome, no line
// numbers, no magic — a plain honest surface for plain honest code. Saves go
// through PUT /api/files/content (atomic, capped, binary-refused).

export default function CodeEditor({ path, onClose }) {
  const [content, setContent] = useState(null) // null = loading
  const [error, setError] = useState(null)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const taRef = useRef(null)

  useEffect(() => {
    let alive = true
    setContent(null)
    setError(null)
    setDirty(false)
    fetchFileContent(path)
      .then((d) => {
        if (alive) setContent(d.content ?? '')
      })
      .catch((err) => {
        if (alive) setError(err.message || 'Could not open that file')
      })
    return () => {
      alive = false
    }
  }, [path])

  // Ctrl/Cmd+S saves — the one editor habit worth honoring
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const save = async () => {
    if (busy || content === null || !dirty) return
    setBusy(true)
    try {
      await saveFileContent(path, content)
      setDirty(false)
      toast('Saved ' + path, 'ok')
    } catch (err) {
      toast(err.message || 'Could not save', 'err')
    } finally {
      setBusy(false)
    }
  }

  const close = () => {
    if (dirty && !window.confirm('You have unsaved changes in ' + path + '. Close anyway?')) return
    onClose(Boolean(dirty && content !== null))
  }

  return (
    <div className="ce-backdrop" role="dialog" aria-label={'Edit ' + path}>
      <div className="ce glass">
        <header className="ce-head">
          <span className="ce-path" title={path}>
            <Icon name="code" size={14} />
            {path}
          </span>
          <span className="ce-head-actions">
            <button className="btn btn-primary" onClick={save} disabled={busy || !dirty || content === null}>
              {busy ? <span className="spin" aria-hidden="true" /> : null}
              {busy ? 'Saving…' : dirty ? 'Save' : 'Saved'}
            </button>
            <button className="btn iconbtn" onClick={close} aria-label="Close the editor" title="Close">
              <Icon name="x" size={15} />
            </button>
          </span>
        </header>

        {error ? (
          <div className="ce-error">
            <Icon name="alert" size={16} />
            <span>{error}</span>
            <button className="btn" onClick={close}>
              Close
            </button>
          </div>
        ) : content === null ? (
          <div className="ce-loading">
            <div className="skeleton ce-sk" />
          </div>
        ) : (
          <textarea
            ref={taRef}
            className="ce-area"
            value={content}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            onChange={(e) => {
              setContent(e.target.value)
              setDirty(true)
            }}
            aria-label={'Editing ' + path}
          />
        )}

        <footer className="ce-foot muted">
          <span>{dirty ? 'Unsaved changes' : 'All changes saved'}</span>
          <span>Ctrl+S saves</span>
        </footer>
      </div>
    </div>
  )
}
