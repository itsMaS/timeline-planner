import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Public project coordinates (the publishable key is safe to ship; all access
// is enforced server-side via token-checked RPCs, RLS and Realtime policies).
export const SUPABASE_URL = 'https://qrkywsxdujxlognlthts.supabase.co'
export const SUPABASE_KEY = 'sb_publishable_kACkHPr69j5z8IQoMostxg_Ync3Z4If'

let client: SupabaseClient | null = null

export function supabase(): SupabaseClient {
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      realtime: { params: { eventsPerSecond: 20 } },
    })
  }
  return client
}

let sessionPromise: Promise<boolean> | null = null

/**
 * Make sure this browser has a (silent, anonymous) Supabase user. Resolves
 * false when anonymous sign-ins are disabled or the network is down; the app
 * then falls back to token-only access with periodic refresh.
 */
export function ensureSession(): Promise<boolean> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const sb = supabase()
      try {
        const { data } = await sb.auth.getSession()
        if (data.session) { await sb.realtime.setAuth(); return true }
        const { error } = await sb.auth.signInAnonymously()
        if (error) { console.warn('[sync] anonymous sign-in unavailable:', error.message); return false }
        await sb.realtime.setAuth()
        return true
      } catch (e) {
        console.warn('[sync] auth failed', e)
        return false
      }
    })()
    // Allow a retry later if the first attempt failed.
    sessionPromise.then(ok => { if (!ok) sessionPromise = null })
  }
  return sessionPromise
}

// ---------------------------------------------------------------- identity shown to collaborators

export interface Identity { name: string; color: string }

const LS_ID = 'tp.identity.v1'
const ADJ = ['Amber', 'Blue', 'Coral', 'Dusky', 'Emerald', 'Fuchsia', 'Golden', 'Hazel', 'Indigo', 'Jade', 'Lilac', 'Mint', 'Navy', 'Olive', 'Pearl', 'Ruby', 'Sage', 'Teal', 'Violet']
const ANIMAL = ['Fox', 'Owl', 'Otter', 'Lynx', 'Heron', 'Bison', 'Koala', 'Panda', 'Raven', 'Tiger', 'Wolf', 'Moth', 'Crane', 'Newt', 'Hare', 'Seal', 'Wren', 'Yak', 'Ibis']
const COLORS = ['#ef4444', '#f97316', '#f59e0b', '#84cc16', '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6', '#8b5cf6', '#d946ef', '#ec4899']

const pick = <T,>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)]

export function getIdentity(): Identity {
  try {
    const raw = localStorage.getItem(LS_ID)
    if (raw) {
      const id = JSON.parse(raw) as Identity
      if (id && id.name && id.color) return id
    }
  } catch { /* fall through */ }
  const id = { name: `${pick(ADJ)} ${pick(ANIMAL)}`, color: pick(COLORS) }
  try { localStorage.setItem(LS_ID, JSON.stringify(id)) } catch { /* ok */ }
  return id
}

export function setIdentity(id: Identity) {
  try { localStorage.setItem(LS_ID, JSON.stringify(id)) } catch { /* ok */ }
}

/** Stable per-tab id so we can ignore our own broadcast echoes. */
export const CLIENT_ID = Math.random().toString(36).slice(2, 12)
