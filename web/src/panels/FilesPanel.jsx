import React, { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../icons.jsx'
import { listFiles, downloadUrl, humanizeBytes, toast } from '../api.js'
import CodeEditor from './CodeEditor.jsx'
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

// --- local fetch helpers (api.js is shared; writes here attach the lock token) ---
const TOKEN_KEY = 'mitti_token'
const getToken = () => {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || ''
  } catch {
    return ''
  }
}
const storeToken = (t) => {
  try {
    if (t) sessionStorage.setItem(TOKEN_KEY, t)
    else sessionStorage.removeItem(TOKEN_KEY)
  } catch {
    /* ignore */
  }
}

async function j(res) {
  const d = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(d.error || res.statusText), { status: res.status })
  return d
}

// Wraps fetch for writes: attaches the lock token, and on 401 clears it so the
// inline token bar re-asks on the next render.
const authedFetch = (url, opts = {}) =>
  fetch(url, {
    ...opts,
    headers: { 'x-mitti-token': getToken(), ...(opts.headers || {}) }
  }).then((res) => {
    if (res.status === 401) {
      storeToken('')
      throw Object.assign(new Error('Locked — enter your access token'), { status: 401 })
    }
    return res
  })

const jsonReq = (url, body) =>
  authedFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(j)

const mkdirReq = (p) => jsonReq('/api/files/mkdir', { path: p })
const renameReq = (path, newName) => jsonReq('/api/files/rename', { path, newName })
const moveReq = (from, toDir) => jsonReq('/api/files/move', { from, toDir })
const copyReq = (from, toDir) => jsonReq('/api/files/copy', { from, toDir })
const deleteManyReq = (paths) => jsonReq('/api/files/delete', { paths })
const deleteReq = (p, force = false) =>
  authedFetch('/api/files?path=' + encodeURIComponent(p) + (force ? '&force=true' : ''), {
    method: 'DELETE'
  }).then(j)

const uploadReq = (file, to, rel) => {
  const fd = new FormData()
  fd.append('file', file)
  fd.append('to', to)
  fd.append('rel', rel)
  return authedFetch('/api/files/upload-multipart', { method: 'POST', body: fd }).then(j)
}

const searchReq = (q) =>
  fetch('/api/files/search?q=' + encodeURIComponent(q)).then(j).then((d) => d.results || [])
const usageReq = () => fetch('/api/files/usage').then(j)
const archiveUrl = (dir) => '/api/files/archive?path=' + encodeURIComponent(dir)

const MODE_LABEL = { rename: 'rename', move: 'move', copy: 'copy' }

const topUsageLabel = (t) => {
  const name = String(t.path || '')
    .split('/')
    .filter(Boolean)
    .pop()
  return (name || 'files') + ' · ' + humanizeBytes(t.bytes)
}

export default function FilesPanel() {
  const [path, setPath] = useState('')
  const [entries, setEntries] = useState(null) // null = loading (skeletons)
  const [mkOpen, setMkOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [q, setQ] = useState('')
  const [results, setResults] = useState(null) // null = not searching
  const [searching, setSearching] = useState(false)
  const [selected, setSelected] = useState(() => new Set())
  const [editing, setEditing] = useState(null) // {mode, name, value, busy}
  const [confirmBulk, setConfirmBulk] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState('')
  const [usage, setUsage] = useState(null)
  const [needToken, setNeedToken] = useState(false)
  const [tokenDraft, setTokenDraft] = useState('')
  const [codeFile, setCodeFile] = useState(null) // vault-relative path of the open editor
  const mountedRef = useRef(true)
  const seqRef = useRef(0)
  const searchSeqRef = useRef(0)
  const bulkTimerRef = useRef(null)
  const fileInputRef = useRef(null)

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

  const loadUsage = useCallback(async () => {
    try {
      const u = await usageReq()
      if (mountedRef.current) setUsage(u || null)
    } catch {
      if (mountedRef.current) setUsage(null)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    // If the vault is locked and we hold no token, surface the inline token bar
    // before the first write fails. The endpoint may not exist yet — stay silent.
    ;(async () => {
      try {
        const d = await fetch('/api/lock-status').then(j)
        if (mountedRef.current && d && d.locked && !getToken()) setNeedToken(true)
      } catch {
        /* not ready yet */
      }
    })()
    return () => {
      mountedRef.current = false
      clearTimeout(bulkTimerRef.current)
    }
  }, [])

  useEffect(() => {
    load(path)
    loadUsage()
  }, [path, load, loadUsage])

  // Debounced search (300ms) — results replace the file list while q is set.
  useEffect(() => {
    const query = q.trim()
    if (!query) {
      setResults(null)
      setSearching(false)
      return
    }
    setSearching(true)
    const t = setTimeout(async () => {
      const seq = ++searchSeqRef.current
      try {
        const r = await searchReq(query)
        if (!mountedRef.current || seq !== searchSeqRef.current) return
        setResults(r)
        setSearching(false)
      } catch (err) {
        if (!mountedRef.current || seq !== searchSeqRef.current) return
        setResults(null)
        setSearching(false)
        toast(err && err.message ? err.message : 'Search failed.', 'err')
      }
    }, 300)
    return () => clearTimeout(t)
  }, [q])

  // Navigation resets transient row state so nothing points at a stale dir.
  const open = (p) => {
    setEntries(null)
    setPath(p)
    setMkOpen(false)
    setNewName('')
    setQ('')
    setResults(null)
    setSelected(new Set())
    setEditing(null)
    setConfirmBulk(false)
  }

  const segments = path.split('/').filter(Boolean)

  const saveToken = (e) => {
    e.preventDefault()
    const t = tokenDraft.trim()
    if (!t) return
    storeToken(t)
    setTokenDraft('')
    setNeedToken(false)
    toast('Token saved', 'ok')
  }

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
      await mkdirReq(joinPath(path, name))
      toast('Folder "' + name + '" created', 'ok')
      setMkOpen(false)
      setNewName('')
      load(path)
      loadUsage()
    } catch (err) {
      if (err && err.status === 401) setNeedToken(true)
      toast(err && err.message ? err.message : 'Could not create the folder.', 'err')
    } finally {
      if (mountedRef.current) setCreating(false)
    }
  }

  const onDelete = async (entry) => {
    const full = joinPath(path, entry.name)
    if (!window.confirm('Delete "' + entry.name + '"?')) return
    try {
      await deleteReq(full)
      toast('Deleted "' + entry.name + '"', 'ok')
      load(path)
      loadUsage()
    } catch (err) {
      if (err && err.status === 401) {
        setNeedToken(true)
        toast(err.message || 'Locked — enter your access token.', 'err')
        return
      }
      const msg = ((err && err.message) || '').toLowerCase()
      if (err && err.status === 400 && msg.includes('not empty')) {
        if (window.confirm('"' + entry.name + '" is not empty. Delete the folder and everything inside it?')) {
          try {
            await deleteReq(full, true)
            toast('Deleted "' + entry.name + '" and its contents', 'ok')
            load(path)
            loadUsage()
          } catch (err2) {
            if (err2 && err2.status === 401) setNeedToken(true)
            toast(err2 && err2.message ? err2.message : 'Could not delete the folder.', 'err')
          }
        }
      } else {
        toast(err && err.message ? err.message : 'Could not delete that item.', 'err')
      }
    }
  }

  // --- row edits: rename / move / copy ---
  const startEdit = (entry, mode) => {
    if (editing && editing.busy) return
    setEditing({ mode, name: entry.name, value: mode === 'rename' ? entry.name : path, busy: false })
  }

  const submitEdit = async (e) => {
    e.preventDefault()
    const ed = editing
    if (!ed || ed.busy) return
    const v = ed.value.trim()
    if (!v && ed.mode !== 'move' && ed.mode !== 'copy') return
    const full = joinPath(path, ed.name)
    setEditing((cur) => (cur && cur.name === ed.name ? { ...cur, busy: true } : cur))
    try {
      if (ed.mode === 'rename') {
        if (v.includes('/')) {
          toast('Names cannot contain slashes.', 'err')
          if (mountedRef.current) setEditing((cur) => (cur && cur.name === ed.name ? { ...cur, busy: false } : cur))
          return
        }
        await renameReq(full, v)
        toast('Renamed to "' + v + '"', 'ok')
      } else if (ed.mode === 'move') {
        await moveReq(full, v)
        toast('Moved "' + ed.name + '" to ' + (v || 'vault') + '/', 'ok')
      } else {
        await copyReq(full, v)
        toast('Copied "' + ed.name + '" to ' + (v || 'vault') + '/', 'ok')
      }
      if (!mountedRef.current) return
      setEditing((cur) => (cur && cur.name === ed.name ? null : cur))
      load(path)
      loadUsage()
    } catch (err) {
      if (!mountedRef.current) return
      if (err && err.status === 401) setNeedToken(true)
      else if (err && err.status === 409) toast('That name already exists in the target folder.', 'err')
      else toast(err && err.message ? err.message : 'Could not ' + (MODE_LABEL[ed.mode] || 'update') + ' the item.', 'err')
      setEditing((cur) => (cur && cur.name === ed.name ? { ...cur, busy: false } : cur))
    }
  }

  // --- bulk selection ---
  const toggleSel = (name) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  const askBulkDelete = () => {
    clearTimeout(bulkTimerRef.current)
    setConfirmBulk(true)
    bulkTimerRef.current = setTimeout(() => setConfirmBulk(false), 3500)
  }

  const bulkDelete = async () => {
    clearTimeout(bulkTimerRef.current)
    setConfirmBulk(false)
    const paths = [...selected].map((n) => joinPath(path, n))
    if (!paths.length) return
    try {
      const r = await deleteManyReq(paths)
      const n = r && typeof r.deleted === 'number' ? r.deleted : paths.length
      toast(n === 1 ? 'Deleted 1 item' : 'Deleted ' + n + ' items', 'ok')
      setSelected(new Set())
      load(path)
      loadUsage()
    } catch (err) {
      if (err && err.status === 401) setNeedToken(true)
      toast(err && err.message ? err.message : 'Could not delete the selected items.', 'err')
    }
  }

  // --- upload: one multipart request per file ---
  const onUploadPick = async (e) => {
    const files = Array.from(e.target.files || [])
    e.target.value = '' // allow re-picking the same files later
    if (!files.length) return
    setUploading(true)
    let ok = 0
    let failed = 0
    for (let i = 0; i < files.length; i++) {
      if (mountedRef.current) setProgress('Uploading ' + (i + 1) + '/' + files.length)
      try {
        await uploadReq(files[i], path, files[i].name)
        ok++
      } catch (err) {
        if (err && err.status === 401) {
          if (mountedRef.current) setNeedToken(true)
          failed = files.length - i
          break
        }
        failed++
      }
    }
    if (mountedRef.current) {
      setUploading(false)
      setProgress('')
    }
    if (ok) toast(ok === 1 ? '1 file uploaded' : ok + ' files uploaded', 'ok')
    if (failed) toast(failed === 1 ? '1 upload failed' : failed + ' uploads failed', 'err')
    if (ok) {
      load(path)
      loadUsage()
    }
  }

  const sorted = entries
    ? [...entries].sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      })
    : null

  const selDirEntry = sorted ? sorted.find((e) => selected.has(e.name) && e.type === 'dir') : null
  const bulkDir = selDirEntry ? joinPath(path, selDirEntry.name) : path

  return (
    <div className="fl-panel">
      {needToken && (
        <form className="banner" onSubmit={saveToken}>
          <Icon name="lock" size={15} />
          <span className="fl-token-label">Vault is locked — enter your access token to make changes.</span>
          <input
            className="fl-token-input"
            type="password"
            value={tokenDraft}
            onChange={(e) => setTokenDraft(e.target.value)}
            placeholder="access token"
            aria-label="Access token"
            autoFocus
          />
          <button type="submit" className="btn btn-primary fl-token-btn" disabled={!tokenDraft.trim()}>
            Save
          </button>
        </form>
      )}

      {usage && (
        <div className="fl-usage">
          <span className="chip">
            <Icon name="cloud" size={12} />
            vault · {humanizeBytes(usage.total)}
          </span>
          {usage.tree && usage.tree[0] && (
            <span className="chip">
              <Icon name="folder" size={12} />
              {topUsageLabel(usage.tree[0])}
            </span>
          )}
        </div>
      )}

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

          <label className="btn">
            <Icon name="upload" size={15} />
            Upload files
            <input
              ref={fileInputRef}
              type="file"
              hidden
              multiple
              onChange={onUploadPick}
              disabled={uploading}
              aria-label="Upload files"
              tabIndex={-1}
            />
          </label>
          {uploading && progress ? <span className="fl-progress">{progress}</span> : null}

          <form className="fl-search" role="search" onSubmit={(e) => e.preventDefault()}>
            <Icon name="search" size={14} className="fl-search-ic" />
            <input
              className="fl-search-input"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search files"
              aria-label="Search files"
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
            />
            {q && (
              <button type="button" className="chip fl-search-clear" onClick={() => setQ('')}>
                Clear
              </button>
            )}
          </form>
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

      {selected.size > 0 && (
        <div className="fl-bulk glass" role="toolbar" aria-label="Selected items">
          <span className="fl-bulk-count">
            {selected.size} selected —
          </span>
          {confirmBulk ? (
            <button className="btn btn-danger" onClick={bulkDelete} autoFocus>
              Sure? Delete now
            </button>
          ) : (
            <button className="btn btn-danger" onClick={askBulkDelete}>
              Delete selected
            </button>
          )}
          <a className="btn" href={archiveUrl(bulkDir)}>
            <Icon name="download" size={15} />
            Download folder
          </a>
          <button className="btn" onClick={() => setSelected(new Set())}>
            Clear selection
          </button>
        </div>
      )}

      {results !== null || searching ? (
        searching && results === null ? (
          <div className="fl-card glass" aria-hidden="true">
            <div className="fl-list">
              {Array.from({ length: 5 }, (_, i) => (
                <div key={i} className="fl-row">
                  <div className="skeleton fl-sk-ic" />
                  <div className="skeleton fl-sk-line" />
                  <div className="skeleton fl-sk-dot" />
                </div>
              ))}
            </div>
          </div>
        ) : results.length === 0 ? (
          <div className="empty">
            <div className="btn iconbtn" aria-hidden="true">
              <Icon name="search" size={22} />
            </div>
            No matches for "{q.trim()}".
          </div>
        ) : (
          <div className="fl-card glass">
            <ul className="fl-list">
              {results.map((r) => {
                const rp = String(r.path || '')
                const isDir = rp.endsWith('/')
                const name = rp.split('/').filter(Boolean).pop() || rp
                const dir = parentOf(rp)
                return (
                  <li key={rp} className="fl-row">
                    <span className="fl-name is-static">
                      <Icon name={isDir ? 'folder' : 'file'} size={17} className={isDir ? 'fl-ic-dir' : 'fl-ic-file'} />
                      <span className="fl-nm">{name}</span>
                    </span>
                    <span className="fl-date muted" title={dir || 'vault'}>
                      {dir || 'vault'}
                    </span>
                    <span className="fl-size muted">{isDir ? '' : humanizeBytes(r.size)}</span>
                    <span className="fl-actions">
                      {!isDir && (
                        <button
                          className="btn iconbtn"
                          onClick={() => setCodeFile(rp)}
                          aria-label={'Edit ' + name}
                          title="Edit"
                        >
                          <Icon name="code" size={15} />
                        </button>
                      )}
                      <button
                        className="btn iconbtn"
                        onClick={() => open(dir)}
                        aria-label={'Open folder ' + (dir || 'vault')}
                        title="Show in folder"
                      >
                        <Icon name="folder" size={15} />
                      </button>
                      {!isDir && (
                        <a
                          className="btn iconbtn"
                          href={downloadUrl(rp)}
                          download={name}
                          aria-label={'Download ' + name}
                          title="Download"
                        >
                          <Icon name="download" size={15} />
                        </a>
                      )}
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>
        )
      ) : sorted === null ? (
        <div className="fl-card glass" aria-hidden="true">
          <div className="fl-list">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="fl-row">
                <div className="skeleton fl-sk-check" />
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
              const isEditing = editing && editing.name === e.name
              return (
                <li key={e.type + ':' + e.name} className="fl-row">
                  <input
                    type="checkbox"
                    className="fl-check"
                    checked={selected.has(e.name)}
                    onChange={() => toggleSel(e.name)}
                    aria-label={'Select ' + e.name}
                  />
                  {isEditing ? (
                    <form
                      className="fl-edit"
                      onSubmit={submitEdit}
                    >
                      <input
                        className="fl-edit-input"
                        value={editing.value}
                        onChange={(ev) =>
                          setEditing((cur) =>
                            cur && cur.name === e.name ? { ...cur, value: ev.target.value } : cur
                          )
                        }
                        onKeyDown={(ev) => {
                          if (ev.key === 'Escape') setEditing(null)
                        }}
                        placeholder={
                          editing.mode === 'rename' ? 'New name' : 'Target folder (blank = vault root)'
                        }
                        aria-label={
                          editing.mode === 'rename'
                            ? 'New name for ' + e.name
                            : 'Target folder for ' + e.name
                        }
                        autoFocus
                        spellCheck={false}
                        disabled={editing.busy}
                      />
                      <button
                        type="submit"
                        className="btn iconbtn"
                        disabled={editing.busy}
                        aria-label="Confirm"
                        title="Confirm"
                      >
                        <Icon name="check" size={15} />
                      </button>
                      <button
                        type="button"
                        className="btn iconbtn"
                        onClick={() => setEditing(null)}
                        disabled={editing.busy}
                        aria-label="Cancel"
                        title="Cancel"
                      >
                        <Icon name="x" size={15} />
                      </button>
                    </form>
                  ) : isDir ? (
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
                        <>
                          <button
                            className="btn iconbtn"
                            onClick={() => setCodeFile(full)}
                            aria-label={'Edit ' + e.name}
                            title="Edit"
                          >
                            <Icon name="code" size={15} />
                          </button>
                          <a
                            className="btn iconbtn"
                            href={downloadUrl(full)}
                            download={e.name}
                            aria-label={'Download ' + e.name}
                            title="Download"
                          >
                            <Icon name="download" size={15} />
                          </a>
                        </>
                      )}
                    <button
                      className="btn iconbtn"
                      onClick={() => startEdit(e, 'rename')}
                      aria-label={'Rename ' + e.name}
                      title="Rename"
                      disabled={Boolean(editing && editing.busy)}
                    >
                      <Icon name="pencil" size={15} />
                    </button>
                    <button
                      className="btn iconbtn"
                      onClick={() => startEdit(e, 'move')}
                      aria-label={'Move ' + e.name}
                      title="Move"
                      disabled={Boolean(editing && editing.busy)}
                    >
                      <Icon name="arrowRight" size={15} />
                    </button>
                    <button
                      className="btn iconbtn"
                      onClick={() => startEdit(e, 'copy')}
                      aria-label={'Copy ' + e.name}
                      title="Copy"
                      disabled={Boolean(editing && editing.busy)}
                    >
                      <Icon name="copy" size={15} />
                    </button>
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

      {codeFile && <CodeEditor path={codeFile} onClose={() => setCodeFile(null)} />}
    </div>
  )
}
