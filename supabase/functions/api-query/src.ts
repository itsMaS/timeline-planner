/**
 * `api_query` Edge Function: the read-side half of the API that needs the
 * app's TypeScript (the expression evaluator, derived fields, processors),
 * which Postgres cannot run. It fetches the document through the same
 * token-checked `api_read` RPC a client would call, so it can do nothing
 * the API token cannot, then evaluates in Deno.
 *
 *   POST /functions/v1/api-query
 *   { "p_api_token": "…", "p_query": "Implemented = no and [VFX Scope] >= 10",
 *     "p_timeline": "Main",            // optional: timeline id or name
 *     "p_compute": true }              // optional: derived fields + processor results
 *   → { "version", "matches": [item ids], "computed"?: { items, sections } }
 *
 * Bundled from src.ts into index.ts by `npm run build:api`; deploy the bundle.
 */
import { computeDoc, prepare, queryItems } from '../../../src/api/compute'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? 'https://qrkywsxdujxlognlthts.supabase.co'
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ code: 'P0001', message: 'POST a JSON body' }, 405)
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json({ code: 'P0001', message: 'Body must be JSON' }, 400) }
  const token = typeof body.p_api_token === 'string' ? body.p_api_token : ''
  if (!token) return json({ code: 'P0001', message: 'API token required' }, 400)
  const apikey = req.headers.get('apikey') ?? ANON_KEY

  // Same RPC, same token check: the function never sees more than the token allows.
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/api_read`, {
    method: 'POST',
    headers: { apikey, Authorization: `Bearer ${apikey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_api_token: token }),
  })
  const text = await res.text()
  if (!res.ok) {
    let msg = text
    try { msg = (JSON.parse(text) as { message?: string }).message ?? text } catch { /* raw */ }
    return json({ code: 'P0001', message: msg }, res.status === 404 ? 400 : res.status)
  }
  const r = JSON.parse(text) as { version: number; doc: unknown }
  const doc = prepare(r.doc)

  let timelineIds: string[] | undefined
  const tl = body.p_timeline
  if (typeof tl === 'string' && tl.trim()) {
    const hit = doc.timelines.find(t => t.id === tl) ?? doc.timelines.find(t => t.name.trim().toLowerCase() === tl.trim().toLowerCase())
    if (!hit) return json({ code: 'P0001', message: `No timeline "${tl}" (have: ${doc.timelines.map(t => t.name).join(', ')})` }, 400)
    timelineIds = [hit.id]
  }
  const query = typeof body.p_query === 'string' ? body.p_query : ''
  let matches: string[]
  try { matches = queryItems(doc, query, timelineIds) } catch (e) { return json({ code: 'P0001', message: (e as Error).message }, 400) }
  const out: Record<string, unknown> = { version: r.version, matches }
  if (body.p_compute === true) out.computed = computeDoc(doc)
  return json(out)
})
