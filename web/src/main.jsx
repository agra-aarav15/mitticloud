import React from 'react'
import { createRoot } from 'react-dom/client'
import './tokens.css'
import App from './App.jsx'

// A render error must not blank the whole app to black — show one honest card.
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('[mitticloud] render error', error, info)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="app">
        <section className="glass" style={{ padding: '28px 24px' }}>
          <div className="brandname" style={{ marginBottom: 8 }}>
            Something broke in the dashboard
          </div>
          <p className="muted" style={{ margin: '0 0 14px', fontSize: 13.5, lineHeight: 1.55 }}>
            The server is fine — only the page hit an error. Reload to get it back; your files,
            photos and sites are untouched.
          </p>
          <pre
            style={{
              margin: '0 0 14px',
              padding: '10px 12px',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 10,
              fontSize: 11.5,
              overflowX: 'auto',
              color: '#a3a3a3',
            }}
          >
            {String(this.state.error && this.state.error.message)}
          </pre>
          <button className="btn btn-primary" onClick={() => window.location.reload()}>
            Reload
          </button>
        </section>
      </div>
    )
  }
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)