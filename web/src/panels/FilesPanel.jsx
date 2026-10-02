import React, { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../icons.jsx'
import { listFiles, mkdir, deleteFile, downloadUrl, humanizeBytes, toast } from '../api.js'
import './FilesPanel.css'

const parentOf = (p) => {
  const i = p.lastIndexOf('/')
  return i === -1 ? '' : p.slice(0, i)
}

const joinPath = (base, name) => (base ? base + '/' + name : name)

const formatDate = (ts) => {
  if (!ts) return '—'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export default function FilesPanel() {
  const [path, setPath] = useState('')
  const [entries, setEntries] = useState(null) // null = loading (skeletons)
  const [mkOpen, setMkOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const mountedRef = useRef(true)
  const seqRef = useRef(0)

  const load = useCallback(async (dir) => {
    const seq = ++seqRef.current
    try {
      const d = await listFiles(dir)
      if (!mountedRef.current || seq !== seqRef.current) return
      setEntries(Array.isArray(d.entries) ? d.entries : [])
    } catch (err) {
      if (!mountedRef.current || seq !== seqRef.current) return
      setEntries([])
      toast(err && err.message ? err.message : 'Could not open that folder.', 'err')
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    load(path)
  }, [path, load])

  // Navigation also closes the New Folder form so it never points at a stale dir.
  const open = (p) => {
    setEntries(null)
    setPath(p)
    setMkOpen(false)
    setNewName('')
  }

  const segments = path.split('/').filter(Boolean)

  const submitFolder = async (e) => {
    e.preventDefault()
    const name = newName.trim()
    if (!name) return
    if (name.includes('/')) {
      toast('Folder names cannot contain slashes.', 'err')
      return
    }
    setCreating(true)
    try {
      await mkdir(joinPath(path, name))
      toast('Folder "' + name + '" created', 'ok')
      setMkOpen(false)
      setNewName('')
      load(path)
    } catch (err) {
      toast(err && err.message ? err.message : 'Could not create the folder.', 'err')
    } finally {
      if (mountedRef.current) setCreating(false)
    }
  }

  const onDelete = async (entry) => {
    const full = joinPath(path, entry.name)
    if (!window.confirm('Delete "' + entry.name + '"?')) return
    try {
      await deleteFile(full)
      toast('Deleted "' + entry.name + '"', 'ok')
      load(path)
    } catch (err) {
      const msg = ((err && err.message) || '').toLowerCase()
      if (err && err.status === 400 && msg.includes('not empty')) {
        if (window.confirm('"' + entry.name + '" is not empty. Delete the folder and everything inside it?')) {
          try {
            await deleteFile(full, true)
            toast('Deleted "' + entry.name + '" and its contents', 'ok')
            load(path)
          } catch (err2) {
            toast(err2 && err2.message ? err2.message : 'Could not delete the folder.', 'err')
          }
        }
      } else {
        toast(err && err.message ? err.message : 'Could not delete that item.', 'err')
      }
    }
  }

  const sorted = entries
    ? [...entries].sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      })
    : null

  return (
    <div className="fl-panel">
      <div className="fl-toolbar">
        <div className="fl-toolbar-left">
          <button
            className="btn iconbtn"
            onClick={() => open(parentOf(path))}
            disabled={path === ''}
            aria-label="Go up one level"
            title="Up one level"
          >
            <Icon name="chevronUp" size={16} />
          </button>

          {mkOpen ? (
            <form className="fl-mkform" onSubmit={submitFolder}>
              <input
                className="fl-mkinput"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setMkOpen(false)
                    setNewName('')
                  }
                }}
                placeholder="Folder name"
                aria-label="New folder name"
                autoFocus
                disabled={creating}
                maxLength={255}
              />
              <button type="submit" className="btn btn-primary" disabled={creating || !newName.trim()}>
                {creating ? 'Creating…' : 'Create'}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setMkOpen(false)
                  setNewName('')
                }}
                disabled={creating}
              >
                Cancel
              </button>
            </form>
          ) : (
            <button className="btn" onClick={() => setMkOpen(true)}>
              <Icon name="folderPlus" size={16} />
              New Folder
            </button>
          )}
        </div>

        <nav className="fl-crumbs" aria-label="Folder path">
          <button
            className={'fl-crumb' + (path === '' ? ' is-current' : '')}
            onClick={() => open('')}
            aria-current={path === '' ? 'location' : undefined}
          >
            <Icon name="cloud" size={15} />
            vault
          </button>
          {segments.map((seg, i) => {
            const segPath = segments.slice(0, i + 1).join('/')
            const isLast = i === segments.length - 1
            return (
              <Fragment key={segPath}>
                <span className="fl-sep" aria-hidden="true">
                  /
                </span>
                <button
                  className={'fl-crumb' + (isLast ? ' is-current' : '')}
                  onClick={() => open(segPath)}
                  aria-current={isLast ? 'location' : undefined}
                >
                  {seg}
                </button>
              </Fragment>
            )
          })}
        </nav>
      </div>

      {sorted === null ? (
        <div className="fl-card glass" aria-hidden="true">
          <div className="fl-list">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="fl-row">
                <div className="skeleton fl-sk-ic" />
                <div className="skeleton fl-sk-line" />
                <div className="skeleton fl-sk-dot" />
              </div>
            ))}
          </div>
        </div>
      ) : sorted.length === 0 ? (
        <div className="empty">
          <div className="btn iconbtn" aria-hidden="true">
            <Icon name="folder" size={22} />
          </div>
          This folder is empty.
        </div>
      ) : (
        <div className="fl-card glass">
          <ul className="fl-list">
            {sorted.map((e) => {
              const full = joinPath(path, e.name)
              const isDir = e.type === 'dir'
              return (
                <li key={e.type + ':' + e.name} className="fl-row">
                  {isDir ? (
                    <button className="fl-name" onClick={() => open(full)} title={'Open ' + e.name}>
                      <Icon name="folder" size={17} className="fl-ic-dir" />
                      <span className="fl-nm">{e.name}</span>
                    </button>
                  ) : (
                    <span className="fl-name is-static">
                      <Icon name="file" size={17} className="fl-ic-file" />
                      <span className="fl-nm">{e.name}</span>
                    </span>
                  )}
                  <span className="fl-date muted">{formatDate(e.modifiedAt)}</span>
                  <span className="fl-size muted">{isDir ? '' : humanizeBytes(e.size)}</span>
                  <span className="fl-actions">
                    {!isDir && (
                      <a
                        className="btn iconbtn"
                        href={downloadUrl(full)}
                        download={e.name}
                        aria-label={'Download ' + e.name}
                        title="Download"
                      >
                        <Icon name="download" size={15} />
                      </a>
                    )}
                    <button
                      className="btn iconbtn btn-danger"
                      onClick={() => onDelete(e)}
                      aria-label={'Delete ' + e.name}
                      title="Delete"
                    >
                      <Icon name="trash" size={15} />
                    </button>
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
