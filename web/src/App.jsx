import React, { useEffect, useState } from 'react'
import StatusPanel from './panels/StatusPanel.jsx'
import PhotosPanel from './panels/PhotosPanel.jsx'
import FilesPanel from './panels/FilesPanel.jsx'
import SandboxPanel from './panels/SandboxPanel.jsx'
import GuidesPanel from './panels/GuidesPanel.jsx'
import { Icon } from './icons.jsx'
import { onToast } from './api.js'

const TABS = [
  { id: 'status', label: 'Status', icon: 'gauge' },
  { id: 'photos', label: 'Photos', icon: 'image' },
  { id: 'files', label: 'Files', icon: 'folder' },
  { id: 'sandbox', label: 'Sandbox', icon: 'cpu' },
  { id: 'guides', label: 'Guides', icon: 'shield' }
]

function Toasts() {
  const [items, setItems] = useState([])
  useEffect(
    () =>
      onToast((t) => {
        setItems((xs) => [...xs, t])
        setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== t.id)), 4000)
      }),
    []
  )
  return (
    <div className="toastwrap" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={'toast ' + (t.type === 'err' ? 'err' : t.type === 'ok' ? 'ok' : '')}>
          {t.msg}
        </div>
      ))}
    </div>
  )
}

export default function App() {
  const [tab, setTab] = useState('status')
  return (
    <>
      <div className="app">
        <header className="topbar glass">
          <div className="brand">
            <div className="brandmark">
              <Icon name="pot" size={22} />
            </div>
            <div>
              <div className="brandname">MittiCloud</div>
              <div className="tagline">Your drawer-phone is a cloud now.</div>
            </div>
          </div>
          <span className="chip chip-grad">v0.4.0</span>
        </header>

        <nav className="tabbar glass" role="tablist" aria-label="Sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={'tab' + (tab === t.id ? ' active' : '')}
              onClick={() => setTab(t.id)}
            >
              <Icon name={t.icon} size={16} />
              {t.label}
            </button>
          ))}
        </nav>

        <main className="main" role="tabpanel">
          {tab === 'status' && <StatusPanel />}
          {tab === 'photos' && <PhotosPanel />}
          {tab === 'files' && <FilesPanel />}
          {tab === 'sandbox' && <SandboxPanel />}
          {tab === 'guides' && <GuidesPanel />}
        </main>

        <footer className="foot muted">MittiCloud · free &amp; open source · runs on the phone in your drawer</footer>
      </div>
      <Toasts />
    </>
  )
}
