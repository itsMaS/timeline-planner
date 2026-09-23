import React, { useState } from 'react'
import { ArrowLeft, Check, Copy, ExternalLink, X } from 'lucide-react'
import { useActiveProject, useActiveShare, useStore } from '../model/store'
import { SUPABASE_KEY, SUPABASE_URL } from '../sync/client'

const DOC_URL = 'https://github.com/itsMaS/timeline-planner/blob/main/API.md'
const TOKEN_PLACEHOLDER = 'YOUR_API_TOKEN'

async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text) } catch {
    const el = document.createElement('textarea')
    el.value = text; document.body.appendChild(el); el.select(); document.execCommand('copy'); el.remove()
  }
}

function CopyBtn({ text, title = 'Copy' }: { text: string; title?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="ghost-btn copy-btn" title={title}
      onClick={() => { void copyText(text); setDone(true); setTimeout(() => setDone(false), 1500) }}
    >
      {done ? <Check width={13} height={13} /> : <Copy width={13} height={13} />}
    </button>
  )
}

function Code({ children }: { children: string }) {
  return (
    <div className="api-code">
      <pre>{children}</pre>
      <CopyBtn text={children} />
    </div>
  )
}

interface Fn {
  name: string
  kind: 'read' | 'write'
  what: string
  params: [string, string][]
  returns: string
  /** Set for the one endpoint that is not a PostgREST function. */
  url?: string
}

const FUNCTIONS: Fn[] = [
  {
    name: 'api_version', kind: 'read',
    what: 'Cheap freshness check. Call it when your window gets focus and re-read only when version moved.',
    params: [],
    returns: '{ id, name, version, updatedAt }',
  },
  {
    name: 'api_read', kind: 'read',
    what: 'The whole project, exactly like Export → Project JSON: timelines, sections, items, types, fields, layers.',
    params: [],
    returns: '{ id, name, version, updatedAt, doc }',
  },
  {
    name: 'api_schema', kind: 'read',
    what: 'Only the schema: timelines, fields (with dropdown options, composites, formulas), field and processor folders, types, hierarchy levels, layers, processors, and every tag in use. Build your tool’s settings from it.',
    params: [],
    returns: '{ id, name, version, timelines, fields, fieldFolders, types, typeFolders, hierarchyLevels, layers, processors, processorFolders, tags }',
  },
  {
    name: 'api-query', kind: 'read', url: 'functions/v1/api-query',
    what: 'Find items with the same rule language as the funnel filter (“Implemented = no and [VFX Scope] >= 10”), and optionally compute what is never stored: derived field values and processor results per section.',
    params: [
      ['p_query', 'optional rule expression; empty matches every item'],
      ['p_timeline', 'optional timeline id or name'],
      ['p_compute', 'optional true to include derived values and processor results'],
    ],
    returns: '{ version, matches: [item ids], computed?: { items, sections } }',
  },
  {
    name: 'api_set_field', kind: 'write',
    what: 'Set one field on an item or a section, for example move a Progress dropdown to “Done”. null unsets it. Values are validated like the app does: options, min/max, whole numbers, single vs multiple.',
    params: [
      ['p_entity_id', 'item or section id'],
      ['p_field_id', 'field id (from api_schema)'],
      ['p_value', 'text: string · int/float: number · toggle: true/false · select: option string or array · ref: id or array of ids · null to unset'],
      ['p_author', 'optional, shown in history'],
    ],
    returns: '{ version, changed, entity }',
  },
  {
    name: 'api_set_tags', kind: 'write',
    what: 'Add and/or remove tags on an item. Existing order is kept, duplicates and blanks dropped.',
    params: [
      ['p_item_id', 'item id'],
      ['p_add', 'optional array of strings'],
      ['p_remove', 'optional array of strings'],
      ['p_author', 'optional'],
    ],
    returns: '{ version, changed, item }',
  },
  {
    name: 'api_update_item', kind: 'write',
    what: 'Change an item’s title, description (Markdown) and/or link. Nothing else: position, type, layer and timeline stay under the planner’s control.',
    params: [
      ['p_item_id', 'item id'],
      ['p_patch', '{ title?, description?, link? } — strings only'],
      ['p_author', 'optional'],
    ],
    returns: '{ version, changed, item }',
  },
  {
    name: 'api_create_item', kind: 'write',
    what: 'Create an item, for example a checkpoint that exists in the scene but not on the timeline. It lands on the timeline you name, else the section’s, else the first one. Without pos it sits right after the last item of the section (at the section start when empty; after the last item of the timeline when no section is given).',
    params: [
      ['p_item', '{ typeName | typeId, title, timelineName? | timelineId?, sectionName? | sectionId?, pos?, duration?, description?, link?, tags?, layerId?, fieldValues? }'],
      ['p_author', 'optional'],
    ],
    returns: '{ version, changed, item }',
  },
  {
    name: 'api_create_field', kind: 'write',
    what: 'Create a field, for example an “Asset GUID” text field the plugin writes into, attached to the types or levels you name, optionally in a folder or inside a composite. Same defaults as the app.',
    params: [
      ['p_field', '{ name, kind?, attach?: [type or level ids / names], folder?, group?, …any setting of api_update_field }'],
      ['p_author', 'optional'],
    ],
    returns: '{ version, changed, field }',
  },
  {
    name: 'api_update_field', kind: 'write',
    what: 'Change a field’s settings: name, help, options, limits, default, formula, badge and the other flags. Its kind, children, parent and folder stay under the app’s control.',
    params: [
      ['p_field_id', 'field id'],
      ['p_patch', '{ name?, help?, unit?, options?, min?, max?, decimals?, maxLength?, defaultValue?, formula?, template?, required?, badge?, … }'],
      ['p_author', 'optional'],
    ],
    returns: '{ version, changed, field }',
  },
]

export function ApiHelpModal() {
  const proj = useActiveProject()
  const share = useActiveShare()
  const setUI = useStore(s => s.setUI)
  const token = share?.apiToken ?? null
  const tok = token ?? TOKEN_PLACEHOLDER
  const rpcUrl = `${SUPABASE_URL}/rest/v1/rpc/`
  const back = () => setUI({ overlay: share ? 'share' : null })

  const curl = `curl -X POST "${rpcUrl}api_version" \\
  -H "apikey: ${SUPABASE_KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"p_api_token":"${tok}"}'`

  const setField = `POST ${rpcUrl}api_set_field
{
  "p_api_token": "${tok}",
  "p_entity_id": "<item id>",
  "p_field_id": "<Progress field id>",
  "p_value": "Done",
  "p_author": "Unity"
}`

  const createItem = `POST ${rpcUrl}api_create_item
{
  "p_api_token": "${tok}",
  "p_author": "Unity",
  "p_item": {
    "typeName": "Checkpoint",
    "sectionName": "Forest_02",
    "title": "Checkpoint_3",
    "tags": ["from-unity"],
    "fieldValues": { "<Progress field id>": "Planned" }
  }
}`

  const query = `POST ${SUPABASE_URL}/functions/v1/api-query
{
  "p_api_token": "${tok}",
  "p_query": "type = Checkpoint and Implemented = no",
  "p_compute": true
}`

  const createField = `POST ${rpcUrl}api_create_field
{
  "p_api_token": "${tok}",
  "p_author": "Unity",
  "p_field": {
    "name": "Asset GUID",
    "kind": "text",
    "help": "Set by the Unity plugin",
    "attach": ["Checkpoint"]
  }
}`

  const csharp = `// Editor-only. Any JSON library works; this uses Newtonsoft (com.unity.nuget.newtonsoft-json).
const string BaseUrl = "${SUPABASE_URL}";
const string PublishableKey = "${SUPABASE_KEY}";

static async Task<string> Rpc(string fn, object args) {
  var req = new UnityWebRequest(BaseUrl + "/rest/v1/rpc/" + fn, "POST");
  req.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(args)));
  req.downloadHandler = new DownloadHandlerBuffer();
  req.SetRequestHeader("apikey", PublishableKey);
  req.SetRequestHeader("Content-Type", "application/json");
  await req.SendWebRequest();
  if (req.responseCode != 200)
    throw new Exception(JObject.Parse(req.downloadHandler.text)["message"]?.ToString() ?? req.error);
  return req.downloadHandler.text;
}

// Mark an item done:
await Rpc("api_set_field", new {
  p_api_token = token, p_entity_id = itemId, p_field_id = progressFieldId, p_value = "Done", p_author = "Unity"
});`

  return (
    <div className="modal-scrim" onPointerDown={e => { if (e.target === e.currentTarget) back() }}>
      <div className="modal apihelp">
        <div className="modal-head">
          {share && (
            <button className="ghost-btn" title="Back to sharing" onClick={back}><ArrowLeft width={16} height={16} /></button>
          )}
          <strong>API for external tools</strong>
          <span className="muted small">— “{proj.name}”</span>
          <span className="grow" />
          <a className="ghost-btn link-btn" href={DOC_URL} target="_blank" rel="noreferrer noopener" title="Full reference (API.md on GitHub)">
            <ExternalLink width={14} height={14} /> API.md
          </a>
          <button className="ghost-btn" onClick={() => setUI({ overlay: null })}><X width={16} height={16} /></button>
        </div>

        <div className="api-doc">
          <section>
            <h3>What it is</h3>
            <p>
              A small HTTP API that lets another program, such as a Unity editor plugin, a build script or a
              spreadsheet, read this project and make a few well-defined changes to it. It is built for
              things like <em>“warn me when the open scene is missing a checkpoint that is on the timeline”</em>
              and <em>“set this item’s Progress to Done from inside the editor”</em>.
            </p>
            <div className="api-cols">
              <div>
                <h4>It can</h4>
                <ul>
                  <li>Read the whole project, or just its schema (timelines, types, fields with options, levels, layers, tags)</li>
                  <li>Find items with the app’s rule language, and read derived field values and processor results</li>
                  <li>Set any field value on an item or section (dropdowns, numbers, text, references)</li>
                  <li>Add and remove tags on items</li>
                  <li>Edit an item’s title, description and link</li>
                  <li>Create items by type name, timeline name and section name</li>
                  <li>Create fields and change their settings (options, limits, defaults, formulas)</li>
                  <li>Check cheaply whether anything changed</li>
                </ul>
              </div>
              <div>
                <h4>It cannot</h4>
                <ul>
                  <li>Delete anything</li>
                  <li>Move or resize items or sections</li>
                  <li>Change types, hierarchy levels or layers, or a field’s kind and place</li>
                  <li>Create, rename or delete timelines, or move items between them</li>
                  <li>Create, rotate or revoke share links</li>
                  <li>Act without a valid API token</li>
                </ul>
              </div>
            </div>
            <p className="muted small">
              Every change made through the API is validated the same way the app validates it, bumps the
              project’s version, shows up in the item’s history (source <code>api</code>, with the author you
              pass), and reaches open tabs within a few seconds. A tab that is behind can never overwrite an API
              change: its save is refused, it pulls the new document, replays its own pending edits and saves again.
            </p>
          </section>

          <section>
            <h3>Getting started</h3>
            <ol>
              <li>Share this project (you have, if you came from the Share dialog). Only the owner sees the API token.</li>
              <li>
                {token
                  ? <>Copy the <strong>API token</strong> from the Share dialog. It is already filled into the examples below.</>
                  : <>Click <strong>Create API token</strong> in the Share dialog and copy it. The examples below use a placeholder until then.</>}
              </li>
              <li>
                Keep the token out of version control: it grants write access to anyone holding it. In Unity, store it in
                <code>EditorPrefs</code> or under <code>UserSettings/</code>, not in a committed asset. <strong>Rotate</strong> it
                in the Share dialog if it leaks; <strong>Revoke</strong> removes it.
              </li>
              <li>Send the request below from a terminal to check that everything is wired up.</li>
            </ol>
            <Code>{curl}</Code>
          </section>

          <section>
            <h3>How a call works</h3>
            <p>
              Every function is a <code>POST</code> to the same base URL followed by the function name. The body is a
              JSON object whose keys are the parameter names; every call takes <code>p_api_token</code>.
            </p>
            <table className="api-table kv">
              <tbody>
                <tr><td>Base URL</td><td><code>{rpcUrl}</code><CopyBtn text={rpcUrl} /></td></tr>
                <tr><td>Header <code>apikey</code></td><td><code>{SUPABASE_KEY}</code><CopyBtn text={SUPABASE_KEY} /></td></tr>
                <tr><td>Header <code>Content-Type</code></td><td><code>application/json</code></td></tr>
                <tr><td>Success</td><td>HTTP 200 with the JSON described per function</td></tr>
                <tr><td>Failure</td><td>HTTP 400 with <code>{'{ "message": "…" }'}</code> written for a human, e.g. <em>"Shipped" is not an option of field "Progress" (options: Planned, In progress, Done)</em></td></tr>
              </tbody>
            </table>
            <p className="muted small">
              The <code>apikey</code> header is the app’s public key (the same one this page ships with). It only
              identifies the project; access is decided by <code>p_api_token</code> alone.
            </p>
          </section>

          <section>
            <h3>Functions</h3>
            <table className="api-table fns">
              <thead>
                <tr><th>Function</th><th>Does</th><th>Parameters (besides <code>p_api_token</code>)</th><th>Returns</th></tr>
              </thead>
              <tbody>
                {FUNCTIONS.map(f => (
                  <tr key={f.name}>
                    <td>
                      <code>{f.name}</code><span className={`api-kind ${f.kind}`}>{f.kind}</span>
                      {f.url && <div className="muted small">Edge Function: <code>{SUPABASE_URL}/{f.url}</code></div>}
                    </td>
                    <td>{f.what}</td>
                    <td>
                      {f.params.length === 0
                        ? <span className="muted">none</span>
                        : <ul className="params">{f.params.map(([n, d]) => <li key={n}><code>{n}</code> {d}</li>)}</ul>}
                    </td>
                    <td><code>{f.returns}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted small">
              Writes return <code>changed: false</code> (and the unchanged version) when the value was already what
              you sent, so calling them repeatedly is safe.
            </p>
          </section>

          <section>
            <h3>Queries and computed values</h3>
            <p>
              <code>api-query</code> takes the same expressions as the funnel filter next to the search box, processor
              conditions and derived field formulas. Names are the entity’s fields (case-insensitive, <code>[brackets]</code>
              when they contain spaces) or built-ins such as <code>title</code>, <code>type</code>, <code>tags</code>,
              <code>layer</code>, <code>pos</code>, <code>duration</code>, <code>section</code>, <code>timeline</code>.
              Operators: <code>and or not</code>, <code>= != &lt; &lt;= &gt; &gt;=</code>, <code>contains</code>,
              <code>has</code>, <code>one of (a, b)</code>, <code>is set</code> / <code>is empty</code>, and arithmetic.
              A bare word that names nothing is text, so <code>Status = blocked</code> needs no quotes.
            </p>
            <Code>{query}</Code>
            <p className="muted small">
              With <code>p_compute: true</code> the answer also carries every derived field value and every processor
              result (text, number and the ids it counted) per section, which <code>api_read</code> never contains
              because they are computed, not stored.
            </p>
          </section>

          <section>
            <h3>Reading the document</h3>
            <ul>
              <li>
                <strong>Timelines</strong> are the subtabs of the project: <code>timelines</code> lists them
                (<code>{'{ id, name, settings }'}</code>) and every item and section carries a <code>timelineId</code>.
                Positions on different timelines are unrelated{proj.timelines.length > 1 ? `; this project has ${proj.timelines.length}` : ''}.
              </li>
              <li>
                <strong>Sections</strong> carry <code>depth</code>, an index into <code>hierarchyLevels</code>
                (0 = {proj.hierarchyLevels[0]?.name ?? 'Chapter'}, 1 = {proj.hierarchyLevels[1]?.name ?? 'Level'}, …).
                To find the section for a scene, match the section’s <code>name</code> at the level you use for scenes.
              </li>
              <li>
                <strong>Items</strong> belong to a section when they share a timeline and <code>section.start ≤ item.pos &lt; section.end</code>.
                Sections nest, so an item is in one section per depth. Resolve <code>item.typeId</code> in
                <code>types</code> to know that an item is, say, a Checkpoint.
              </li>
              <li>
                <strong>Field values</strong> live in <code>fieldValues</code>, keyed by field <em>id</em>, and only hold
                explicitly set values. A missing key means the type’s or the field’s default applies. Dropdown values are
                arrays even for single-choice fields: <code>["Done"]</code>.
              </li>
              <li>
                <strong>Ids</strong> are stable random strings. Store them in your tool rather than names; names can be renamed.
              </li>
            </ul>
          </section>

          <section>
            <h3>Recipes for a Unity editor tool</h3>
            <h4>Validate the open scene</h4>
            <p>
              <code>api_read</code> once. Find the section whose name equals the scene name. Collect items with a
              position inside it whose type is Checkpoint. Look each one up in the scene (by title, or by an id you
              stored in the item’s link or a text field) and warn about the ones that are missing. For scene
              checkpoints that have no item, offer “Add to timeline”:
            </p>
            <Code>{createItem}</Code>
            <h4>Mark an item done</h4>
            <p>
              Let the tool’s settings pick a dropdown field and an option from <code>api_schema</code> (say
              <em>Progress</em> and <em>Done</em>). The button then calls:
            </p>
            <Code>{setField}</Code>
            <h4>Keep the plugin’s own data on the timeline</h4>
            <p>
              On first run, look for a text field named <em>Asset GUID</em> in <code>api_schema</code>. When it is
              missing, create it attached to the types you care about and remember its id in the tool’s settings:
            </p>
            <Code>{createField}</Code>
            <h4>Stay fresh</h4>
            <p>
              Call <code>api_version</code> when the tool window gets focus and re-read only when the version moved.
              It increases by one on every save, whether from the app or the API.
            </p>
            <h4>C# sketch</h4>
            <Code>{csharp}</Code>
          </section>

          <section>
            <h3>Good to know</h3>
            <ul>
              <li>One token per project, held by the owner. There is no per-token scoping; rotate it if it leaks.</li>
              <li><code>api_read</code> returns everything, including inline images on projects that were never shared before. Prefer <code>api_schema</code> and <code>api_version</code> for frequent calls.</li>
              <li>Name lookups (<code>typeName</code>, <code>timelineName</code>, <code>sectionName</code>) are case-insensitive and must be unique; when two sections share a name the error lists their ids so you can pass <code>sectionId</code>, or name the timeline to search only there.</li>
              <li>Two edits to the very same entity within a couple of seconds, one from a tab and one from the API, resolve to whichever came last.</li>
              <li>The full reference with every value shape and error lives in <a href={DOC_URL} target="_blank" rel="noreferrer noopener">API.md</a>.</li>
            </ul>
          </section>
        </div>

        <div className="modal-foot between">
          {share ? <button className="ghost-btn" onClick={back}><ArrowLeft width={13} height={13} /> Back to sharing</button> : <span />}
          <button className="primary-btn" onClick={() => setUI({ overlay: null })}>Done</button>
        </div>
      </div>
    </div>
  )
}
