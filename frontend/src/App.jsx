import { useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { API_URL, getHealth, getHistory, newSessionId, sendChat } from './api'

marked.setOptions({ breaks: true, gfm: true })
const renderMarkdown = (text) => ({ __html: DOMPurify.sanitize(marked.parse(text || '')) })

const SIMULATIONS = [
  { value: '', label: 'Off', hint: 'Normal requests' },
  { value: 'key_1=429', label: 'key_1 → 429', hint: 'Rate limit on key 1, expect key_2' },
  { value: 'key_1=500', label: 'key_1 → 500', hint: 'Server error on key 1, expect key_2' },
  { value: 'key_1=429,key_2=500', label: 'key_1 429 · key_2 500', hint: 'All keys fail, expect 503' },
  { value: '*=429', label: 'Every key → 429', hint: 'All keys fail, expect 503' },
]

const SUGGESTIONS = ['What is the capital of France?', 'My name is Asha. Remember it.', 'What is my name?']

function MetaRow({ meta }) {
  const cached = meta.resolution_source === 'LLM_CACHE'
  return (
    <div className="meta">
      <span className={`chip source ${cached ? 'cache' : 'live'}`} title="Resolution source">
        <span className="dot" />
        <span data-testid="meta-source">{meta.resolution_source}</span>
      </span>
      <span className="chip" title="Model used">
        <span className="k">model</span>
        <span data-testid="meta-model">{meta.model}</span>
      </span>
      <span className="chip" title="Server-measured latency">
        <span className="k">latency</span>
        <span data-testid="meta-latency">{meta.latency_ms} ms</span>
      </span>
      <span className="chip" title="Input tokens for this request only">
        <span className="k">in</span>
        <span data-testid="meta-input-tokens">{meta.input_tokens}</span>
      </span>
      <span className="chip" title="Output tokens for this reply only">
        <span className="k">out</span>
        <span data-testid="meta-output-tokens">{meta.output_tokens}</span>
      </span>
      <span className="chip subtle" title="Key that answered (never the secret)">
        <span className="k">key</span>
        <span data-testid="meta-key-id">{meta.key_id ?? 'null'}</span>
      </span>
      {meta.fallback_attempts > 0 && (
        <span className="chip warn" title="Keys that failed before this one succeeded">
          <span className="k">failover</span>
          <span data-testid="meta-fallback-attempts">{meta.fallback_attempts}</span>
        </span>
      )}
    </div>
  )
}

function Message({ m }) {
  if (m.role === 'user') {
    return (
      <div className="row user">
        <div className="bubble user-bubble" data-testid="user-message">
          {m.content}
          {m.simulate && <div className="sim-tag">X-Simulate-Failure: {m.simulate}</div>}
        </div>
      </div>
    )
  }
  if (m.role === 'error') {
    return (
      <div className="row bot">
        <div className="bubble error-bubble" role="alert" data-testid="error-message">
          <strong>{m.status ? `Error ${m.status}` : 'Connection error'}</strong>
          <span>{m.content}</span>
        </div>
      </div>
    )
  }
  return (
    <div className="row bot">
      <div className="bubble bot-bubble" data-testid="assistant-message">
        <div className="md" dangerouslySetInnerHTML={renderMarkdown(m.content)} />
        <MetaRow meta={m.metadata} />
      </div>
    </div>
  )
}

export default function App() {
  const sessionId = useMemo(() => newSessionId(), []) // a new session on every page load
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [simulate, setSimulate] = useState('')
  const [pending, setPending] = useState(false)
  const [health, setHealth] = useState(null)
  const [history, setHistory] = useState(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const endRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    let alive = true
    const load = () =>
      getHealth()
        .then((h) => alive && setHealth(h))
        .catch((e) => alive && setHealth({ ok: false, error: e.message }))
    load()
    const t = setInterval(load, 30000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, pending])

  const totals = useMemo(() => {
    const replies = messages.filter((m) => m.role === 'assistant')
    return {
      replies: replies.length,
      cached: replies.filter((m) => m.metadata.resolution_source === 'LLM_CACHE').length,
      failovers: replies.filter((m) => m.metadata.fallback_attempts > 0).length,
    }
  }, [messages])

  async function send(text) {
    const message = (text ?? input).trim()
    if (!message || pending) return
    setInput('')
    const sim = simulate
    setMessages((ms) => [...ms, { role: 'user', content: message, simulate: sim }])
    setPending(true)
    try {
      const res = await sendChat({ sessionId, message, systemPrompt, simulate: sim })
      setMessages((ms) => [...ms, { role: 'assistant', content: res.reply, metadata: res.metadata }])
    } catch (e) {
      setMessages((ms) => [...ms, { role: 'error', status: e.status, content: e.message }])
    } finally {
      setPending(false)
      inputRef.current?.focus()
    }
  }

  async function showHistory() {
    try {
      setHistory({ loading: true })
      setHistory({ data: await getHistory(sessionId) })
    } catch (e) {
      setHistory({ error: `${e.status || ''} ${e.message}`.trim() })
    }
  }

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }

  const healthLabel = !health
    ? 'Checking backend…'
    : health.ok
      ? `Backend ok · ${health.keys_configured} keys · cache ${health.cache_enabled ? 'on' : 'off'}`
      : health.detail
        ? `Backend degraded · ${health.detail}`
        : 'Backend unreachable'

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path d="M4 5h16v10H9l-5 4z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
            </svg>
          </span>
          <div>
            <h1>Failover Chat</h1>
            <p>LiteLLM key pool · response cache · SQLite sessions</p>
          </div>
        </div>
        <div className="top-right">
          <span className={`status ${health?.ok ? 'ok' : health ? 'bad' : ''}`} data-testid="health-status">
            <span className="dot" />
            <span className="status-text">{healthLabel}</span>
          </span>
          <button className="ghost panel-toggle" onClick={() => setPanelOpen((v) => !v)} aria-expanded={panelOpen}>
            {panelOpen ? 'Close' : 'Settings'}
          </button>
        </div>
      </header>

      <div className="layout">
        <main className="chat">
          <div className="scroll">
            {messages.length === 0 ? (
              <div className="empty">
                <h2>Ask anything.</h2>
                <p>
                  Each reply shows where it came from (<code>LIVE_INFERENCE</code> or <code>LLM_CACHE</code>), the model, the latency and the tokens of that
                  request only. Send the same first message from a fresh page to see a cache hit.
                </p>
                <div className="suggestions">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} className="suggestion" onClick={() => send(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="thread">
                {messages.map((m, i) => (
                  <Message key={i} m={m} />
                ))}
                {pending && (
                  <div className="row bot">
                    <div className="bubble bot-bubble typing" aria-live="polite" aria-label="Assistant is typing">
                      <span />
                      <span />
                      <span />
                    </div>
                  </div>
                )}
                <div ref={endRef} />
              </div>
            )}
          </div>

          <div className="composer-wrap">
            {simulate && (
              <div className="sim-banner">
                <span>
                  Failure simulation on: <code>X-Simulate-Failure: {simulate}</code>
                </span>
                <button className="link" onClick={() => setSimulate('')}>
                  turn off
                </button>
              </div>
            )}
            <form
              className="composer"
              onSubmit={(e) => {
                e.preventDefault()
                send()
              }}
            >
              <textarea
                ref={inputRef}
                data-testid="chat-input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Message the assistant…"
                rows={1}
                maxLength={4000}
                autoFocus
              />
              <button type="submit" data-testid="send-button" className="send" disabled={pending || !input.trim()} aria-label="Send message">
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
                  <path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </form>
            <div className="foot">
              <span>Enter to send · Shift+Enter for a new line · {input.trim().length}/4000</span>
              <span>
                Session <code data-testid="session-id">{sessionId}</code>
              </span>
            </div>
          </div>
        </main>

        <aside className={`panel ${panelOpen ? 'open' : ''}`}>
          <section>
            <h3>System prompt</h3>
            <p className="help">Optional. Overrides the default prompt for this session.</p>
            <textarea
              data-testid="system-prompt-input"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="e.g. You are a friendly travel guide. Answer in two sentences."
              rows={4}
            />
          </section>

          <section>
            <h3>Failover lab</h3>
            <p className="help">
              Adds an <code>X-Simulate-Failure</code> header to your next messages.
            </p>
            <div className="sims" role="radiogroup" aria-label="Failure simulation">
              {SIMULATIONS.map((s) => (
                <label key={s.value || 'off'} className={`sim ${simulate === s.value ? 'on' : ''}`}>
                  <input type="radio" name="sim" value={s.value} checked={simulate === s.value} onChange={() => setSimulate(s.value)} />
                  <span className="sim-label">{s.label}</span>
                  <span className="sim-hint">{s.hint}</span>
                </label>
              ))}
            </div>
          </section>

          <section>
            <h3>This session</h3>
            <div className="stats">
              <div>
                <b>{totals.replies}</b>
                <span>replies</span>
              </div>
              <div>
                <b>{totals.cached}</b>
                <span>cache hits</span>
              </div>
              <div>
                <b>{totals.failovers}</b>
                <span>failovers</span>
              </div>
            </div>
            <button className="ghost full" onClick={showHistory} data-testid="history-button">
              View stored history (SQLite)
            </button>
            {history && (
              <pre className="history" data-testid="history-output">
                {history.loading ? 'Loading…' : history.error ? history.error : JSON.stringify(history.data, null, 2)}
              </pre>
            )}
            <button className="ghost full" onClick={() => window.location.reload()}>
              Start a new session
            </button>
          </section>

          <p className="api">
            API: <code>{API_URL}</code>
          </p>
        </aside>
      </div>
    </div>
  )
}
