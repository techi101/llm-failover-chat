// Backend base URL. Order: runtime config (Docker) -> build-time env (Vercel) -> local default.
const runtime = (typeof window !== 'undefined' && window.__APP_CONFIG__) || {}
export const API_URL = (runtime.API_URL || import.meta.env.VITE_API_URL || 'http://localhost:8000').replace(/\/+$/, '')

export function newSessionId() {
  const raw = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(16).slice(2) + Date.now().toString(16))
  return 's-' + raw.replace(/-/g, '').slice(0, 12)
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function describe(status, detail) {
  if (status === 503) return 'All providers are unavailable right now: every API key in the pool failed. Please try again in a moment.'
  if (status === 422) {
    if (Array.isArray(detail)) {
      return 'Invalid request: ' + detail.map((d) => `${(d.loc || []).filter((x) => x !== 'body').join('.') || 'body'}: ${d.msg}`).join('; ')
    }
    return 'Invalid request: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))
  }
  if (typeof detail === 'string') return detail
  return `Request failed with status ${status}.`
}

async function request(path, options = {}) {
  let res
  try {
    res = await fetch(API_URL + path, options)
  } catch {
    throw new ApiError(0, `Can't reach the backend at ${API_URL}. It may be waking up; please try again in a few seconds.`)
  }
  let body = null
  try {
    body = await res.json()
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) throw new ApiError(res.status, describe(res.status, body && body.detail))
  return body
}

export function sendChat({ sessionId, message, systemPrompt, simulate }) {
  const headers = { 'Content-Type': 'application/json' }
  if (simulate) headers['X-Simulate-Failure'] = simulate
  const payload = { session_id: sessionId, message }
  if (systemPrompt && systemPrompt.trim()) payload.system_prompt = systemPrompt.trim()
  return request('/chat', { method: 'POST', headers, body: JSON.stringify(payload) })
}

export async function getHealth() {
  // /health returns 503 with a JSON body when degraded (e.g. no keys); show that body instead of "unreachable".
  let res
  try {
    res = await fetch(API_URL + '/health')
  } catch {
    throw new ApiError(0, 'unreachable')
  }
  const body = await res.json().catch(() => ({}))
  return { ...body, ok: res.ok }
}
export const getHistory = (sessionId) => request(`/sessions/${encodeURIComponent(sessionId)}/messages`)
