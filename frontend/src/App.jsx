import { useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { API_URL, getHealth, getHistory, newSessionId, sendChat } from './api'

marked.setOptions({ breaks: true, gfm: true })
const renderMarkdown = (text) => ({ __html: DOMPurify.sanitize(marked.parse(text || '')) })

const FAIL_CODES = ['429', '500', '502', '503']
const STARTERS = [
  { text: 'What is the capital of France?', hint: 'Then reload and ask again to get a cache hit' },
  { text: 'My name is Asha. Please remember it.', hint: 'Then ask "What is my name?"' },
  { text: 'Explain an API rate limit in two sentences.', hint: 'A longer answer, more output tokens' },
]

const providerOf = (model = '') => {
  const p = model.split('/')[0]
  return { gemini: 'Google Gemini', groq: 'Groq', openai: 'OpenAI', anthropic: 'Anthropic', mistral: 'Mistral' }[p] || p
}
const shortModel = (model = '') => model.split('/').slice(1).join('/') || model

// Parse 'key_1=429,*=500' into { key_1: '429', '*': '500' }
const parseSim = (h) => Object.fromEntries((h || '').split(',').filter((p) => p.includes('=')).map((p) => p.split('=').map((x) => x.trim())))

/* ---------- route trace: the path one request took through the gateway ---------- */
function Route({ meta, simulate, keyIds }) {
  if (meta.resolution_source === 'LLM_CACHE') {
    return (
      <ol className="route" aria-label="Request route">
        <li className="hop hop-cache">
          <span className="hop-mark" aria-hidden>
            <svg viewBox="0 0 16 16"><path d="M3 8.5l3 3 7-7" /></svg>
          </span>
          Served from cache, no key used
        </li>
      </ol>
    )
  }
  const sim = parseSim(simulate)
  const answered = meta.key_id
  const idx = keyIds.indexOf(answered)
  const tried = idx >= 0 ? keyIds.slice(0, idx + 1) : [...Array(meta.fallback_attempts).fill('?'), answered]
  return (
    <ol className="route" aria-label="Request route">
      {tried.map((k, i) => {
        const ok = k === answered
        const code = sim[k] || sim['*']
        return (
          <li key={i} className={`hop ${ok ? 'hop-ok' : 'hop-fail'}`}>
            <span className="hop-mark" aria-hidden>
              {ok ? <svg viewBox="0 0 16 16"><path d="M3 8.5l3 3 7-7" /></svg> : <svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" /></svg>}
            </span>
            <span className="hop-key">{k}</span>
            <span className="hop-note">{ok ? 'answered' : code ? `returned ${code}` : 'failed'}</span>
          </li>
        )
      })}
    </ol>
  )
}

function Reply({ m, keyIds }) {
  const meta = m.metadata
  const cached = meta.resolution_source === 'LLM_CACHE'
  return (
    <article className={`msg msg-bot ${cached ? 'is-cache' : ''}`} data-testid="assistant-message">
      <div className="md" dangerouslySetInnerHTML={renderMarkdown(m.content)} />
      <footer className="receipt">
        <Route meta={meta} simulate={m.simulate} keyIds={keyIds} />
        <dl className="facts">
          <div className="fact fact-source">
            <dt>Source</dt>
            <dd>
              <span className={`source ${cached ? 'source-cache' : 'source-live'}`} data-testid="meta-source">
                {meta.resolution_source}
              </span>
            </dd>
          </div>
          <div className="fact fact-model">
            <dt>Model</dt>
            <dd className="mono" data-testid="meta-model" title={providerOf(meta.model)}>
              {meta.model}
            </dd>
          </div>
          <div className="fact">
            <dt>Latency</dt>
            <dd data-testid="meta-latency">{meta.latency_ms} ms</dd>
          </div>
          <div className="fact">
            <dt>Input tokens</dt>
            <dd data-testid="meta-input-tokens">{meta.input_tokens}</dd>
          </div>
          <div className="fact">
            <dt>Output tokens</dt>
            <dd data-testid="meta-output-tokens">{meta.output_tokens}</dd>
          </div>
          <div className="fact">
            <dt>Key</dt>
            <dd className="mono" data-testid="meta-key-id">{meta.key_id ?? 'null'}</dd>
          </div>
        </dl>
      </footer>
    </article>
  )
}

function Message({ m, keyIds }) {
  if (m.role === 'user') {
    return (
      <div className="msg msg-user" data-testid="user-message">
        <p>{m.content}</p>
        {m.simulate && (
          <span className="sent-header">
            with header <code>X-Simulate-Failure: {m.simulate}</code>
          </span>
        )}
      </div>
    )
  }
  if (m.role === 'error') {
    const fix =
      m.status === 503
        ? 'Clear the simulated failures in the gateway panel, or wait a moment and send again.'
        : m.status === 422
          ? 'Edit the message and send it again.'
          : 'Check your connection and send again. A sleeping backend can take a few seconds to wake.'
    return (
      <div className="msg msg-error" role="alert" data-testid="error-message">
        <strong>{m.status === 503 ? 'All providers unavailable (503)' : m.status ? `Request rejected (${m.status})` : 'Backend not reachable'}</strong>
        <p>{m.content}</p>
        <p className="error-fix">{fix}</p>
      </div>
    )
  }
  return <Reply m={m} keyIds={keyIds} />
}

/* ---------- gateway panel ---------- */
function KeyRow({ k, value, onChange, stats }) {
  const failing = value !== 'ok'
  return (
    <li className={`key ${failing ? 'key-failing' : ''}`}>
      <div className="key-head">
        <span className="key-id">{k.key_id}</span>
        <span className="key-provider">{providerOf(k.model)}</span>
      </div>
      <div className="key-model mono">{shortModel(k.model)}</div>
      <div className="key-stats">
        <span>
          <b>{stats.answered}</b> answered
        </span>
        <span>
          <b>{stats.failed}</b> failed
        </span>
      </div>
      <div className="seg" role="radiogroup" aria-label={`Simulate a failure on ${k.key_id}`}>
        {['ok', ...FAIL_CODES].map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={value === c}
            className={`seg-btn ${value === c ? 'on' : ''} ${c === 'ok' ? 'seg-ok' : 'seg-fail'}`}
            onClick={() => onChange(c)}
            data-testid={`sim-${k.key_id}-${c}`}
          >
            {c === 'ok' ? 'Healthy' : c}
          </button>
        ))}
      </div>
    </li>
  )
}

export default function App() {
  const sessionId = useMemo(() => newSessionId(), []) // a new session on every page load
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [sim, setSim] = useState({}) // { key_1: '429', ... }
  const [pending, setPending] = useState(false)
  const [health, setHealth] = useState(null)
  const [history, setHistory] = useState(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const endRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    let alive = true
    const load = () =>
      getHealth()
        .then((h) => alive && setHealth(h))
        .catch(() => alive && setHealth({ ok: false, unreachable: true }))
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

  const keys = useMemo(() => {
    if (health?.keys?.length) return health.keys
    const n = health?.keys_configured || 2
    return Array.from({ length: n }, (_, i) => ({ key_id: `key_${i + 1}`, model: '' }))
  }, [health])
  const keyIds = keys.map((k) => k.key_id)

  const header = useMemo(
    () =>
      Object.entries(sim)
        .filter(([, v]) => v && v !== 'ok')
        .map(([k, v]) => `${k}=${v}`)
        .join(','),
    [sim],
  )

  const stats = useMemo(() => {
    const s = { replies: 0, cache: 0, failovers: 0, tokensIn: 0, tokensOut: 0, perKey: {} }
    keyIds.forEach((k) => (s.perKey[k] = { answered: 0, failed: 0 }))
    for (const m of messages) {
      if (m.role !== 'assistant') continue
      const md = m.metadata
      s.replies++
      if (md.resolution_source === 'LLM_CACHE') s.cache++
      if (md.fallback_attempts > 0) s.failovers++
      if (md.key_id && s.perKey[md.key_id]) s.perKey[md.key_id].answered++
      const idx = keyIds.indexOf(md.key_id)
      keyIds.slice(0, Math.max(idx, 0)).forEach((k) => s.perKey[k].failed++)
    }
    return s
  }, [messages, keyIds])

  async function send(text) {
    const message = (text ?? input).trim()
    if (!message || pending) return
    setInput('')
    const h = header
    setMessages((ms) => [...ms, { role: 'user', content: message, simulate: h }])
    setPending(true)
    try {
      const res = await sendChat({ sessionId, message, systemPrompt, simulate: h })
      setMessages((ms) => [...ms, { role: 'assistant', content: res.reply, metadata: res.metadata, simulate: h }])
    } catch (e) {
      setMessages((ms) => [...ms, { role: 'error', status: e.status, content: e.message }])
    } finally {
      setPending(false)
      inputRef.current?.focus()
    }
  }

  async function showHistory() {
    setHistory({ loading: true })
    try {
      setHistory({ data: await getHistory(sessionId) })
    } catch (e) {
      setHistory({ error: e.status === 404 ? 'Nothing stored yet. Send a message first; failed requests are never stored.' : e.message })
    }
  }

  const copySession = async () => {
    try {
      await navigator.clipboard.writeText(sessionId)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {
      /* clipboard blocked */
    }
  }

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }

  const status = !health ? 'checking' : health.ok ? 'ok' : 'bad'
  const statusText = !health
    ? 'Connecting to backend'
    : health.ok
      ? `Backend healthy, ${health.keys_configured} keys, cache ${health.cache_enabled ? 'on' : 'off'}`
      : health.detail
        ? `Backend degraded: ${health.detail}`
        : 'Backend not reachable'

  return (
    <div className="app">
      <header className="bar">
        <div className="brand">
          <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden>
            <circle cx="7" cy="16" r="4" />
            <circle cx="25" cy="8" r="4" />
            <circle cx="25" cy="24" r="4" />
            <path d="M11 16h4c3 0 4-8 6-8M15 16c3 0 4 8 6 8" />
          </svg>
          <span className="brand-name">Failover Chat</span>
        </div>
        <div className="bar-right">
          <span className={`health health-${status}`} data-testid="health-status" title={statusText}>
            <span className="health-dot" aria-hidden />
            <span className="health-text">{statusText}</span>
          </span>
          <button className="btn btn-quiet" onClick={() => window.location.reload()}>
            New chat
          </button>
          <button className="btn btn-quiet panel-toggle" onClick={() => setPanelOpen((v) => !v)} aria-expanded={panelOpen} aria-controls="gateway">
            Gateway
            {header && <span className="pill-dot" aria-label="failures simulated" />}
          </button>
        </div>
      </header>

      <div className="layout">
        <main className="chat">
          <div className="scroll">
            {messages.length === 0 ? (
              <section className="intro">
                <h1>Ask something. Every answer shows the route it took.</h1>
                <p className="lede">
                  Requests go through a pool of {keys.length} API keys. If a key is rate limited or down, the next one answers. Repeated questions come
                  back from the cache in about a millisecond.
                </p>
                <ul className="starters">
                  {STARTERS.map((s) => (
                    <li key={s.text}>
                      <button className="starter" onClick={() => send(s.text)}>
                        <span className="starter-text">{s.text}</span>
                        <span className="starter-hint">{s.hint}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                <ol className="tour">
                  <li>Send a question and look at the route under the answer.</li>
                  <li>Click New chat, send the same question, and it comes from the cache.</li>
                  <li>In the gateway panel, set key_1 to 429 and send again to watch it fail over.</li>
                </ol>
              </section>
            ) : (
              <div className="thread">
                {messages.map((m, i) => (
                  <Message key={i} m={m} keyIds={keyIds} />
                ))}
                {pending && (
                  <div className="msg msg-bot msg-pending" aria-live="polite">
                    <span className="pulse" aria-hidden />
                    {header ? `Sending with ${header}` : 'Waiting for the model'}
                  </div>
                )}
                <div ref={endRef} />
              </div>
            )}
          </div>

          <div className="composer-area">
            {header && (
              <div className="sim-strip">
                <span>
                  Next message is sent with <code>X-Simulate-Failure: {header}</code>
                </span>
                <button className="link" onClick={() => setSim({})}>
                  Clear
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
              <label htmlFor="chat-input" className="sr-only">
                Message
              </label>
              <textarea
                id="chat-input"
                ref={inputRef}
                data-testid="chat-input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Write a message"
                rows={1}
                maxLength={4000}
                autoFocus
              />
              <button type="submit" data-testid="send-button" className="send" disabled={pending || !input.trim()}>
                Send
              </button>
            </form>
            <div className="composer-foot">
              <span>Enter sends, Shift+Enter adds a line</span>
              <span className={input.trim().length > 3800 ? 'near-limit' : ''}>{input.trim().length} / 4000</span>
            </div>
          </div>
        </main>

        <aside id="gateway" className={`panel ${panelOpen ? 'open' : ''}`} aria-label="Gateway">
          <section className="panel-sec">
            <div className="sec-head">
              <h2>Key pool</h2>
              <span className="sec-meta">tried in this order</span>
            </div>
            <p className="help">Make a key fail on purpose. The choice is sent as a request header, for your next messages only.</p>
            <ol className="keys">
              {keys.map((k) => (
                <KeyRow
                  key={k.key_id}
                  k={k}
                  value={sim[k.key_id] || 'ok'}
                  stats={stats.perKey[k.key_id] || { answered: 0, failed: 0 }}
                  onChange={(v) => setSim((s) => ({ ...s, [k.key_id]: v }))}
                />
              ))}
            </ol>
            <button className="btn btn-block btn-danger-quiet" onClick={() => setSim(Object.fromEntries(keyIds.map((k) => [k, '429'])))}>
              Fail every key (expect 503)
            </button>
          </section>

          <section className="panel-sec">
            <h2>This chat</h2>
            <dl className="tally">
              <div>
                <dt>Replies</dt>
                <dd>{stats.replies}</dd>
              </div>
              <div>
                <dt>Cache hits</dt>
                <dd>{stats.cache}</dd>
              </div>
              <div>
                <dt>Failovers</dt>
                <dd>{stats.failovers}</dd>
              </div>
            </dl>
            <div className="session-row">
              <span>Session</span>
              <code data-testid="session-id">{sessionId}</code>
              <button className="link" onClick={copySession}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <button className="btn btn-block" onClick={showHistory} data-testid="history-button">
              Show stored history
            </button>
            {history && (
              <div className="history" data-testid="history-output">
                {history.loading && <p className="help">Loading from SQLite</p>}
                {history.error && <p className="help">{history.error}</p>}
                {history.data && (
                  <>
                    <p className="help">
                      {history.data.messages.length} messages in SQLite, from <code>GET /sessions/{'{id}'}/messages</code>
                    </p>
                    <pre>{JSON.stringify(history.data, null, 2)}</pre>
                  </>
                )}
              </div>
            )}
          </section>

          <section className="panel-sec">
            <h2>
              <label htmlFor="system-prompt">System prompt</label>
            </h2>
            <p className="help">Optional. Sets the assistant's behaviour for this chat and is part of the cache key.</p>
            <textarea
              id="system-prompt"
              data-testid="system-prompt-input"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="You are a friendly travel guide. Answer in two sentences."
              rows={3}
            />
          </section>

          <p className="api-note">
            API <code>{API_URL}</code>
          </p>
        </aside>
        {panelOpen && <button className="scrim" aria-label="Close gateway panel" onClick={() => setPanelOpen(false)} />}
      </div>
    </div>
  )
}
