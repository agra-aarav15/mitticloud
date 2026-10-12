import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../icons.jsx'
import { fetchPhotos, humanizeBytes, toast } from '../api.js'
import './PhotosPanel.css'

async function j(res) {
  const d = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(d.error || res.statusText), { status: res.status })
  return d
}

// One request per photo — the endpoint answers {ok, duplicate, path}.
const uploadOneReq = (file) => {
  const fd = new FormData()
  fd.append('photo', file)
  return fetch('/api/photos/one', { method: 'POST', body: fd }).then(j)
}

const setFavoriteReq = (path, favorite) =>
  fetch('/api/photos/' + encodeURIComponent(path) + '/favorite', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ favorite })
  }).then(j)

const deletePhotoReq = (path) =>
  fetch('/api/photos?path=' + encodeURIComponent(path), { method: 'DELETE' }).then(j)

const PHOTOS_ARCHIVE_URL = '/api/photos/archive'

export default function PhotosPanel() {
  const [photos, setPhotos] = useState(null) // null = first load (skeletons)
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState('')
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
    return () => {
      mountedRef.current = false
    }
  }, [load])

  // Upload loop: one POST per photo, then a duplicates-skipped toast at the end.
  const onPick = async (e) => {
    const files = Array.from(e.target.files || [])
    e.target.value = '' // allow re-picking the same file later
    if (!files.length) return
    setUploading(true)
    let ok = 0
    let dup = 0
    let failed = 0
    let firstErr = ''
    for (let i = 0; i < files.length; i++) {
      if (mountedRef.current) setProgress('Uploading ' + (i + 1) + '/' + files.length)
      try {
        const r = await uploadOneReq(files[i])
        if (r && r.duplicate) dup++
        else ok++
      } catch (err) {
        failed++
        if (!firstErr) firstErr = err && err.message ? err.message : ''
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
    if (failed)
      toast(
        (failed === 1 ? '1 upload failed' : failed + ' uploads failed') + (firstErr ? ': ' + firstErr : ''),
        'err'
      )
    load()
  }

  const onDelete = async (p) => {
    if (!window.confirm('Delete "' + p.name + '"? This cannot be undone.')) return
    try {
      await deletePhotoReq(p.path)
      toast('Photo deleted', 'ok')
      load()
    } catch (err) {
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
      toast(err && err.message ? err.message : 'Could not update the favorite.', 'err')
    }
  }

  // Inside the Android app the phone itself picks and streams the photos, so
  // the upload survives whatever Android does to this WebView while the
  // picker is open. Desktop keeps the plain file input.
  const native = typeof window !== 'undefined' && window.MittiCloud && window.MittiCloud.pickPhotos
    ? window.MittiCloud
    : null

  const startPick = () => {
    if (native) {
      setUploading(true)
      native.pickPhotos()
    } else if (inputRef.current) inputRef.current.click()
  }

  useEffect(() => {
    window.onNativePhotosDone = (json) => {
      let r = null
      try {
        r = JSON.parse(json)
      } catch {
        r = null
      }
      if (mountedRef.current) setUploading(false)
      if (!r) return
      if (Array.isArray(r.uploaded)) {
        toast(r.uploaded.length === 1 ? '1 photo uploaded' : r.uploaded.length + ' photos uploaded', 'ok')
      } else if (r.error) {
        toast(r.error, 'err')
      }
      load()
    }
    return () => {
      delete window.onNativePhotosDone
    }
  }, [load])

  const count = photos ? photos.length : 0

  return (
    <div className="ph-panel">
      <div className="ph-toolbar">
        <div className="ph-actions">
          <button className="btn btn-primary" onClick={startPick} disabled={uploading}>
            {uploading ? <span className="ph-spinner" aria-hidden="true" /> : <Icon name="upload" size={16} />}
            {uploading ? 'Uploading...' : 'Upload Photos'}
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
        <div className="ph-empty">
          <div className="ph-empty-icon" aria-hidden="true">
            <Icon name="image" size={26} />
          </div>
          <div className="ph-empty-title">Your vault is empty</div>
          <div className="ph-empty-sub muted">
            Every photo you upload lives on this phone — private, unlimited, free. Upload once,
            safe forever.
          </div>
          <button className="btn btn-primary" onClick={startPick} disabled={uploading}>
            <Icon name="upload" size={15} /> Upload your first photos
          </button>
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
