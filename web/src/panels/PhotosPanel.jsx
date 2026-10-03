import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../icons.jsx'
import { fetchPhotos, humanizeBytes, toast } from '../api.js'
import './PhotosPanel.css'

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

// One request per photo — the endpoint answers {ok, duplicate, path}.
const uploadOneReq = (file) => {
  const fd = new FormData()
  fd.append('photo', file)
  return authedFetch('/api/photos/one', { method: 'POST', body: fd }).then(j)
}

const setFavoriteReq = (path, favorite) =>
  authedFetch('/api/photos/' + encodeURIComponent(path) + '/favorite', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ favorite })
  }).then(j)

const deletePhotoReq = (path) =>
  authedFetch('/api/photos?path=' + encodeURIComponent(path), { method: 'DELETE' }).then(j)

const PHOTOS_ARCHIVE_URL = '/api/photos/archive'

export default function PhotosPanel() {
  const [photos, setPhotos] = useState(null) // null = first load (skeletons)
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState('')
  const [needToken, setNeedToken] = useState(false)
  const [tokenDraft, setTokenDraft] = useState('')
  const inputRef = useRef(null)
  const mountedRef = useRef(true)

  const load = useCallback(async () => {
    try {
      const list = await fetchPhotos()
      if (!mountedRef.current) return
      setPhotos(Array.isArray(list) ? list : [])
    } catch (err) {
      if (!mountedRef.current) return
      setPhotos([])
      toast(err && err.message ? err.message : 'Could not load photos. Check the server and try again.', 'err')
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    load()
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
    }
  }, [load])

  const saveToken = (e) => {
    e.preventDefault()
    const t = tokenDraft.trim()
    if (!t) return
    storeToken(t)
    setTokenDraft('')
    setNeedToken(false)
    toast('Token saved', 'ok')
  }

  // Upload loop: one POST per photo, then a duplicates-skipped toast at the end.
  const onPick = async (e) => {
    const files = Array.from(e.target.files || [])
    e.target.value = '' // allow re-picking the same file later
    if (!files.length) return
    setUploading(true)
    let ok = 0
    let dup = 0
    let failed = 0
    for (let i = 0; i < files.length; i++) {
      if (mountedRef.current) setProgress('Uploading ' + (i + 1) + '/' + files.length)
      try {
        const r = await uploadOneReq(files[i])
        if (r && r.duplicate) dup++
        else ok++
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
    if (ok) {
      toast(
        ok + (ok === 1 ? ' photo uploaded' : ' photos uploaded') + (dup ? ' · ' + dup + ' duplicates skipped' : ''),
        'ok'
      )
    } else if (dup) {
      toast(dup === 1 ? '1 duplicate skipped' : dup + ' duplicates skipped', 'info')
    }
    if (failed) toast(failed === 1 ? '1 upload failed' : failed + ' uploads failed', 'err')
    load()
  }

  const onDelete = async (p) => {
    if (!window.confirm('Delete "' + p.name + '"? This cannot be undone.')) return
    try {
      await deletePhotoReq(p.path)
      toast('Photo deleted', 'ok')
      load()
    } catch (err) {
      if (err && err.status === 401) setNeedToken(true)
      toast(err && err.message ? err.message : 'Could not delete the photo.', 'err')
    }
  }

  // Optimistic favorite toggle; reverts on failure.
  const toggleFav = async (p) => {
    const next = !p.favorite
    setPhotos((ps) => (ps || []).map((x) => (x.path === p.path ? { ...x, favorite: next } : x)))
    try {
      await setFavoriteReq(p.path, next)
    } catch (err) {
      if (!mountedRef.current) return
      setPhotos((ps) => (ps || []).map((x) => (x.path === p.path ? { ...x, favorite: !next } : x)))
      if (err && err.status === 401) setNeedToken(true)
      toast(err && err.message ? err.message : 'Could not update the favorite.', 'err')
    }
  }

  const count = photos ? photos.length : 0

  return (
    <div className="ph-panel">
      {needToken && (
        <form className="banner" onSubmit={saveToken}>
          <Icon name="lock" size={15} />
          <span className="ph-token-label">Vault is locked — enter your access token to make changes.</span>
          <input
            className="ph-token-input"
            type="password"
            value={tokenDraft}
            onChange={(e) => setTokenDraft(e.target.value)}
            placeholder="access token"
            aria-label="Access token"
            autoFocus
          />
          <button type="submit" className="btn btn-primary ph-token-btn" disabled={!tokenDraft.trim()}>
            Save
          </button>
        </form>
      )}

      <div className="ph-toolbar">
        <div className="ph-actions">
          <button
            className="btn btn-primary"
            onClick={() => inputRef.current && inputRef.current.click()}
            disabled={uploading}
          >
            {uploading ? <span className="ph-spinner" aria-hidden="true" /> : <Icon name="upload" size={16} />}
            {uploading ? 'Uploading…' : 'Upload Photos'}
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={onPick}
            tabIndex={-1}
            aria-hidden="true"
          />
          {uploading && progress ? <span className="ph-progress">{progress}</span> : null}
          <button className="btn" onClick={load} disabled={uploading}>
            <Icon name="refresh" size={16} />
            Refresh
          </button>
          <a className="btn" href={PHOTOS_ARCHIVE_URL}>
            <Icon name="download" size={16} />
            Download all
          </a>
        </div>
        {photos && (
          <span className="ph-count muted">
            {count === 1 ? '1 photo' : count + ' photos'}
          </span>
        )}
      </div>

      {photos === null ? (
        <div className="ph-grid" aria-hidden="true">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="ph-tile glass">
              <div className="skeleton ph-sk" />
            </div>
          ))}
        </div>
      ) : count === 0 ? (
        <div className="empty">
          <div className="btn iconbtn" aria-hidden="true">
            <Icon name="image" size={22} />
          </div>
          No photos yet — upload your first memories.
        </div>
      ) : (
        <div className="ph-grid">
          {photos.map((p) => (
            <figure key={p.path} className="ph-tile glass">
              <div className="ph-media">
                <img src={p.url} alt={p.name} loading="lazy" />
                <button
                  className={'ph-star' + (p.favorite ? ' is-fav' : '')}
                  onClick={() => toggleFav(p)}
                  aria-label={(p.favorite ? 'Remove from favorites: ' : 'Add to favorites: ') + p.name}
                  aria-pressed={Boolean(p.favorite)}
                  title={p.favorite ? 'Remove from favorites' : 'Add to favorites'}
                >
                  <Icon name="star" size={15} />
                </button>
                <button
                  className="btn iconbtn btn-danger ph-del"
                  onClick={() => onDelete(p)}
                  aria-label={'Delete ' + p.name}
                  title="Delete"
                >
                  <Icon name="trash" size={15} />
                </button>
              </div>
              <figcaption className="ph-meta">
                <span className="ph-name" title={p.name}>
                  {p.name}
                </span>
                <span className="ph-size muted">{humanizeBytes(p.size)}</span>
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </div>
  )
}
