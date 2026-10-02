import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../icons.jsx'
import { fetchPhotos, uploadPhotos, deletePhoto, humanizeBytes, toast } from '../api.js'
import './PhotosPanel.css'

export default function PhotosPanel() {
  const [photos, setPhotos] = useState(null) // null = first load (skeletons)
  const [uploading, setUploading] = useState(false)
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

  const onPick = async (e) => {
    const files = Array.from(e.target.files || [])
    e.target.value = '' // allow re-picking the same file later
    if (!files.length) return
    setUploading(true)
    try {
      const res = await uploadPhotos(files)
      const n = res && Array.isArray(res.uploaded) ? res.uploaded.length : files.length
      toast(n === 1 ? '1 photo uploaded' : n + ' photos uploaded', 'ok')
      await load()
    } catch (err) {
      toast(err && err.message ? err.message : 'Upload failed. Try again.', 'err')
    } finally {
      if (mountedRef.current) setUploading(false)
    }
  }

  const onDelete = async (p) => {
    if (!window.confirm('Delete "' + p.name + '"? This cannot be undone.')) return
    try {
      await deletePhoto(p.path)
      toast('Photo deleted', 'ok')
      load()
    } catch (err) {
      toast(err && err.message ? err.message : 'Could not delete the photo.', 'err')
    }
  }

  const count = photos ? photos.length : 0

  return (
    <div className="ph-panel">
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
          <button className="btn" onClick={load} disabled={uploading}>
            <Icon name="refresh" size={16} />
            Refresh
          </button>
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
