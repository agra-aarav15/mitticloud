import React, { useEffect, useState } from 'react'
import StatusPanel from './panels/StatusPanel.jsx'
import PhotosPanel from './panels/PhotosPanel.jsx'
import FilesPanel from './panels/FilesPanel.jsx'
import HostPanel from './panels/HostPanel.jsx'
import RemotePanel from './panels/RemotePanel.jsx'
import GuidesPanel from './panels/GuidesPanel.jsx'
import HomePanel from './panels/HomePanel.jsx'
import { Icon } from './icons.jsx'
import { onToast } from './api.js'

const TABS = [
  { id: 'home', label: 'Home', icon: 'pot' },
  { id: 'status', label: 'Status', icon: 'gauge' },
  { id: 'photos', label: 'Photos', icon: 'image' },
  { id: 'files', label: 'Files', icon: 'folder' },
  { id: 'host', label: 'Host', icon: 'globe' },
  { id: 'remote', label: 'Remote', icon: 'bot' },
  { id: 'guides', label: 'Guides', icon: 'shield' }
]

function Toasts() {
  const [items, setItems] = useState([])
  useEffect(
    () =>
      onToast((t) => {
        setItems((xs) => [...xs, t])
        // errors stick around long enough to read; everything else is quick
        const life = t.type === 'err' ? 9000 : 4000
        setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== t.id)), life)
      }),
    []
  )
  const dismiss = (id) => setItems((xs) => xs.filter((x) => x.id !== id))
  return (
    <div className="toastwrap" role="status" aria-live="polite">
      {items.map((t) => (
        <div
          key={t.id}
          className={'toast ' + (t.type === 'err' ? 'err' : t.type === 'ok' ? 'ok' : '')}
          onClick={() => dismiss(t.id)}
          title="Tap to dismiss"
        >
          {t.msg}
        </div>
      ))}
    </div>
  )
}

const VALID_TABS = TABS.map((t) => t.id)
const tabFromHash = () => {
  const h = window.location.hash.replace('#', '')
  return VALID_TABS.includes(h) ? h : 'home'
}

export default function App() {
  const [tab, setTabState] = useState(tabFromHash)
  const setTab = (id) => {
    setTabState(id)
    window.history.replaceState(null, '', id === 'home' ? '#' : '#' + id)
    window.scrollTo(0, 0)
  }
  useEffect(() => {
    const onHash = () => setTabState(tabFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
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
          <div className="main-fade" key={tab}>
            {tab === 'home' && <HomePanel onGoTo={setTab} />}
            {tab === 'status' && <StatusPanel />}
            {tab === 'photos' && <PhotosPanel />}
            {tab === 'files' && <FilesPanel />}
            {tab === 'host' && <HostPanel />}
            {tab === 'remote' && <RemotePanel />}
            {tab === 'guides' && <GuidesPanel onGoTo={setTab} />}
          </div>
        </main>

        <footer className="foot muted">
          MittiCloud · free &amp; open source · runs on the phone in your drawer · v0.13.0
        </footer>
      </div>
      <Toasts />
    </>
  )
}
