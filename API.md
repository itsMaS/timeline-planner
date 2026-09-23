# Timeline Planner API

A small HTTP API for external tools, built for a Unity editor plugin: read a
shared project, query items with the app's rule language, set field values
(for example a *Progress* dropdown), add and remove tags, edit an item's text,
create items, and create or adjust **fields**. It is deliberately narrow. The
API token cannot change types, hierarchy levels, layers or timelines, delete
anything, move items, or manage share links; those stay in the app.

A project holds one or more **timelines** (the subtabs of a project tab in the
app). They share the schema; each has its own sections, items and settings.
Items and sections carry `timelineId`.

Everything is a Postgres function exposed through Supabase's REST layer
(PostgREST), so any HTTP client works: `UnityWebRequest`, `HttpClient`, curl.
The one exception is `api-query` (rule evaluation and computed values), an
Edge Function with its own URL and the same headers and error shape.

## Getting a token

1. Share the project (toolbar → Share). Only the owner of a shared project
   sees the **API token** row.
2. Click **Create API token**. Copy it. **Rotate** invalidates the old token
   and mints a new one; **Revoke** removes it (create a new one later).

Keep the token out of version control. It grants write access to the project
to anyone who has it. Store it the way you would store any other secret in a
Unity project, for example in `UserSettings/` or `EditorPrefs`, not in a
committed `ScriptableObject`.

## Calling a function

```
POST https://qrkywsxdujxlognlthts.supabase.co/rest/v1/rpc/<function>
apikey: sb_publishable_kACkHPr69j5z8IQoMostxg_Ync3Z4If
Content-Type: application/json

{ "p_api_token": "<token>", ...other parameters }
```

- The `apikey` header is the app's public key (the same one shipped in the web
  app; see `src/sync/client.ts`). It identifies the project, not you. Access
  is decided by `p_api_token` alone.
- Parameters are the JSON body, keyed by parameter name. Optional parameters
  can be left out.
- Success: HTTP 200 with the JSON object documented below.
- Failure: HTTP 400 (or 404 for an unknown function name) with
  `{"code": "P0001", "message": "…", …}`. The `message` is meant for a human,
  for example `"Shipped" is not an option of field "Progress" (options:
  Planned, In progress, Done)`. An invalid or revoked token also fails with
  400: `Invalid or revoked API token`.

curl example:

```bash
curl -X POST "https://qrkywsxdujxlognlthts.supabase.co/rest/v1/rpc/api_version" \
  -H "apikey: sb_publishable_kACkHPr69j5z8IQoMostxg_Ync3Z4If" \
  -H "Content-Type: application/json" \
  -d '{"p_api_token":"YOUR_TOKEN"}'
```

C# sketch (editor-only):

```csharp
static async Task<string> Rpc(string fn, object args) {
  var req = new UnityWebRequest($"{BaseUrl}/rest/v1/rpc/{fn}", "POST");
  req.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(args)));
  req.downloadHandler = new DownloadHandlerBuffer();
  req.SetRequestHeader("apikey", PublishableKey);
  req.SetRequestHeader("Content-Type", "application/json");
  await req.SendWebRequest();
  if (req.responseCode != 200) throw new Exception(JObject.Parse(req.downloadHandler.text)["message"]?.ToString());
  return req.downloadHandler.text;
}
// Rpc("api_set_field", new { p_api_token = token, p_entity_id = id, p_field_id = progressField, p_value = "Done", p_author = "Unity" })
```

## Reading

### `api_version`

Cheap freshness check.

```jsonc
// → 
{ "id": "…", "name": "Linear game", "version": 42, "updatedAt": "2026-09-16T12:00:00+00:00" }
```

`version` increases by one on every save, from the app or the API. Fetch the
document again only when it moved.

### `api_read`

The whole document, exactly as *Export → Project JSON* writes it (see the
README for the format).

```jsonc
// →
{ "id": "…", "name": "…", "version": 42, "updatedAt": "…", "doc": { /* Project */ } }
```

Things a Unity tool typically needs from `doc`:

- `doc.timelines`: `{ id, name, settings }`, in tab order. Every project has
  at least one (older projects were migrated to a single timeline named
  *Main*). `settings` holds the unit, grid and spine display settings of that
  timeline.
- `doc.sections`: `{ id, name, timelineId, depth, start, end, fieldValues }`.
  `depth` indexes `doc.hierarchyLevels` (0 = Chapter, 1 = Level, … as named
  in the project). **Match a scene by section name**: the section at the
  *Level* depth whose `name` equals the scene name (on the timeline you
  care about, when names repeat across timelines).
- `doc.items`: `{ id, typeId, timelineId, pos, duration, title, description,
  tags, link, fieldValues }`. An item belongs to a section when they share a
  `timelineId` and `section.start <= item.pos < section.end` (sections nest,
  so an item is in one section per depth). Positions on different timelines
  are unrelated.
- `doc.types`: `{ id, name, icon, color, folderId, fields: [{ fieldId, defaultValue }] }`.
  Resolve `item.typeId` here to know that an item is a *Checkpoint*.
- `doc.typeFolders`: `{ id, name, parentId, fields: [{ fieldId, defaultValue }] }`.
  A type inherits the fields of its folder and of every folder above it, on
  top of its own `fields`; the nearest attachment wins when the same field
  appears more than once along that chain.
- `doc.fields`: field definitions (below). `item.fieldValues` is keyed by
  field **id**, and holds only explicitly set values; when a key is missing,
  the effective value is the nearest attachment's `defaultValue` (the type's,
  else its folders' from the innermost outward), else the field's
  `defaultValue`, else unset.

Value shapes in `fieldValues`, by field `kind`:

| kind     | stored as                              |
|----------|----------------------------------------|
| `text`   | string                                 |
| `int`    | number (integer)                       |
| `float`  | number                                 |
| `toggle` | boolean                                |
| `select` | array of option strings (single-choice fields still use a one-element array, e.g. `["Done"]`) |
| `ref`    | array of item/section ids              |
| `group`  | nothing: a composite has no value of its own, its children do |

The app ignores `camera`, `cameras`, `filters`, `views`, `activeViewId` and
`activeTimelineId` for anything but its own UI; a tool can too. The
top-level `settings` object is the legacy copy that seeds new timelines;
the display settings that matter are on each timeline.

### Fields in detail

A field definition is
`{ id, name, kind, help, required, showInTooltip, showName, defaultValue,
maxLength, min, max, decimals, unit, options, selectMultiple, refTargets,
refMultiple, refShowLinks, folderId, badge, children, template, parentId,
formula }`. The last six are newer and optional in stored documents (the app
fills them in on load):

- **Folders.** `folderId` points into `doc.fieldFolders`
  (`{ id, name, color, icon, collapsed, parentId }`, nesting like type
  folders). Folders only group fields in the sidebar, inspector and exports;
  they carry no attachments. Processors have the same in `doc.processorFolders`
  and `processor.folderId`.
- **Composites.** A field of kind `group` owns other fields: `children` lists
  their ids in display order and each child has `parentId` set to the group.
  A composite is attached to a type or level as one unit, so a child counts as
  attached whenever its group is. Children keep their own `fieldValues`
  entries (keyed by the child's id); the group has none. `template` is an
  optional display string with `{Child name}` placeholders (empty: children
  joined with " · "). A group attachment may carry
  `childDefaults: { <childId>: value }` on top of the field defaults.
- **Derived fields.** A non-empty `formula` makes the field read-only and
  computed on read, in the same expression language as queries (below): it
  can use any field attached to the same entity (its siblings inside a
  composite first) and the built-ins, and the result is coerced to the
  field's declared `kind`. Derived values are **never stored**, so
  `api_read` shows nothing for them; ask `api-query` with `p_compute` for the
  values.
- **Badges.** `badge: true` on a `toggle` shows it as a ✓ / ✗ badge on the
  item's icon instead of in the label.
- **Processors** (`doc.processors`, attached to hierarchy levels) may carry a
  `where` expression; only entries inside the section that satisfy it are
  aggregated. Results are computed on read, never stored (again see
  `api-query`).
- **Filters** (`doc.filters` and each view's `filters`) gained `rules` (an
  expression string, AND-ed with the other filters), `offFields` and
  `offProcessors` (ids hidden everywhere but the inspector). They stay
  per user and are of no interest to a tool.

### `api-query`

Evaluate a rule expression against every item and, optionally, compute
what is never stored: derived field values and processor results. This is
the one endpoint that is **not** a PostgREST function; it is an Edge
Function, because the expression evaluator is the app's own TypeScript.
It reads the document through `api_read` with your token, so it can do
nothing the token cannot.

```
POST https://qrkywsxdujxlognlthts.supabase.co/functions/v1/api-query
apikey: sb_publishable_kACkHPr69j5z8IQoMostxg_Ync3Z4If
Content-Type: application/json

{ "p_api_token": "<token>",
  "p_query": "Implemented = no and [VFX Scope] >= 10",   // optional; empty = every item
  "p_timeline": "Main",                                  // optional: timeline id or name
  "p_compute": true }                                    // optional, default false
// →
{ "version": 42,
  "matches": ["item id", …],
  "computed": {                                          // only with p_compute
    "items":    { "<item id>": { "<derived field id>": value } },
    "sections": { "<section id>": {
        "fields":     { "<derived field id>": value },
        "processors": { "<processor id>": { "text": "12 / 30", "value": 12, "matched": ["item id", …],
                                            "contributions": { "<item id>": 5, … } } } } } }
```

Errors come back the same way as from the functions
(`{"code":"P0001","message":"…"}`, HTTP 400), including parse errors:
`Bad query: Missing closing ]`. `matches` are item ids in document
order. `computed` only lists entities that have something to report, and
only non-null values.

**The expression language** (the same text the app's funnel filter,
processor conditions and derived formulas use):

- Names refer to the entity's fields (case-insensitive; a child of a
  composite also answers to `Group.child`) or to built-ins. On items:
  `title, type, tags, layer, pos, duration, end, description, link, id,
  section, sections, timeline, created by`. On sections: `name, title, level,
  start, end, length, description, id, parent, sections, timeline`. A field
  named like a built-in shadows it; `$type` always means the built-in. Names
  with spaces or symbols go in `[brackets]`. A bare word that names nothing
  is taken as text, so `Status = blocked` works without quotes; strings may
  also be quoted with `"` or `'`.
- Operators, loosest first: `or` / `||`, `and` / `&&`, `not` / `!`,
  comparisons `= == != <> < <= > >=`, `contains`, `has`, `one of (a, b)` /
  `in`, `is set` / `is empty` / `is not set`; then `+ -`, `* / %` and unary
  `-`. Lists are parenthesised comma lists.
- Functions: `if(cond, a, b)`, `min`, `max`, `abs`, `round(x, decimals)`,
  `floor`, `ceil`, `len` / `count`, `sum`, `avg`, `coalesce`, `lower`,
  `upper`, `contains`, `empty`.
- Values are numbers, strings, booleans (`yes` / `no` / `true` / `false`),
  lists of strings (dropdowns, tags, and references, which read as the titles
  of what they point at) or null (unset). Comparisons are loose: numbers
  numerically, text case-insensitively, a list against a scalar is
  membership. Arithmetic treats null as 0; an unset toggle equals `no`.

Examples:

```
Implemented = no and [VFX Scope] >= 10
Stage one of (Blocked, Review) or tags has boss
type = Checkpoint and section contains Forest
[Blocked by] is set and duration > 2
```

### `api_schema`

The schema half of the document, plus every tag currently in use. Enough to
build a settings UI ("which field is *Progress*, which option means *done*")
without downloading all items.

```jsonc
// →
{
  "id": "…", "name": "…", "version": 42,
  "timelines": [ { "id": "timeline-0", "name": "Main", "settings": { "…": "…" } } ],
  "fields": [ { "id": "f1", "name": "Progress", "kind": "select",
                "options": ["Planned", "In progress", "Done"], "selectMultiple": false,
                "required": false, "defaultValue": null, "min": null, "max": null,
                "folderId": null, "badge": false, "children": [], "template": "", "parentId": null, "formula": "", "…": "…" } ],
  "fieldFolders": [ { "id": "ff1", "name": "Production", "color": "#8b5cf6", "icon": "Folder", "collapsed": false, "parentId": null } ],
  "types": [ { "id": "t1", "name": "Checkpoint", "icon": "Flag", "color": "#22c55e",
               "defaultLayerId": null, "fields": [ { "fieldId": "f1", "defaultValue": null } ] } ],
  "typeFolders": [ … ],
  "hierarchyLevels": [ { "id": "l1", "name": "Chapter", "fields": [], "processors": [] },
                       { "id": "l2", "name": "Level", "fields": [ … ], "processors": [] } ],
  "layers": [ { "id": "…", "name": "Critical", "…": "…" } ],
  "processors": [ { "id": "p1", "name": "Remaining VFX", "op": "sum", "fieldId": "f7", "where": "Implemented = no", "folderId": null, "…": "…" } ],
  "processorFolders": [ … ],
  "tags": ["implemented", "needs-art"]
}
```

## Writing

Every write:

- validates against the live schema and fails with a readable message rather
  than storing something the app cannot show;
- changes only the entity named, inside the stored document (no full-document
  save, so nobody's concurrent edit is overwritten);
- bumps `version`, records an entry in the entity's history (visible in the
  app's Inspector, source *api*, author `p_author` or "API");
- reaches open tabs on their next refresh (a few seconds), or immediately
  when live updates are on (the app's Realtime channel, which needs anonymous
  sign-ins enabled in Supabase).

Every write returns `{ "version": <new version>, "changed": true|false, … }`
plus the affected entity. `changed: false` means the call was a no-op (the
value was already set); nothing was saved and `version` is unchanged.

All write functions accept an optional `p_author` (string) shown in history,
for example `"Unity (Martynas)"`.

### `api_set_field`

Set one field on an item **or section**. `null` unsets it (the default applies
again).

```jsonc
{ "p_api_token": "…", "p_entity_id": "<item or section id>", "p_field_id": "<field id>",
  "p_value": "Done",          // see accepted values below
  "p_author": "Unity" }       // optional
// →
{ "version": 43, "changed": true, "entity": { …the updated item or section… } }
```

Accepted `p_value` by kind:

| kind     | accepted                                                                                  |
|----------|-------------------------------------------------------------------------------------------|
| `text`   | string (`maxLength` enforced); `""` unsets                                                |
| `int`    | whole number within `min`/`max`                                                            |
| `float`  | number within `min`/`max`                                                                  |
| `toggle` | `true` / `false` (also accepts `"yes"`/`"no"`, `"on"`/`"off"`, `1`/`0`)                    |
| `select` | one option string, or an array of option strings (array of one unless `selectMultiple`)    |
| `ref`    | one id, or an array of ids (array of one unless `refMultiple`); targets must exist and be of an allowed type/level |

Errors: unknown entity or field; the field is not attached to the entity's
type or one of its folders (items) or hierarchy level (sections); value
shape or range; the field is a composite (set its children instead) or
derived (computed on read, cannot be set). A child of a composite is set
by its own id and counts as attached whenever its group is.

### `api_set_tags`

Add and/or remove tags on an item. Order of existing tags is kept; duplicates
and blanks are dropped.

```jsonc
{ "p_api_token": "…", "p_item_id": "…", "p_add": ["implemented"], "p_remove": ["todo"] }
// →
{ "version": 44, "changed": true, "item": { … } }
```

Both `p_add` and `p_remove` are optional.

### `api_update_item`

Change an item's `title`, `description` (Markdown) and/or `link`. Nothing else
is accepted, so position, type, layer and timeline stay under the planner's
control.

```jsonc
{ "p_api_token": "…", "p_item_id": "…", "p_patch": { "link": "unity://Assets/Scenes/Forest_02.unity#Checkpoint_3" } }
// →
{ "version": 45, "changed": true, "item": { … } }
```

### `api_create_item`

Create an item, for example a checkpoint that exists in the scene but not on
the timeline.

```jsonc
{ "p_api_token": "…", "p_author": "Unity",
  "p_item": {
    "typeName": "Checkpoint",        // or "typeId"
    "title": "Checkpoint_3",
    "timelineName": "Main",          // or "timelineId"; optional
    "sectionName": "Forest_02",      // or "sectionId"; optional
    "pos": 14.5,                     // optional
    "duration": 0,                   // optional, default 0
    "description": "", "link": "",   // optional
    "tags": ["from-unity"],          // optional
    "layerId": null,                 // optional, must exist
    "fieldValues": { "<fieldId>": "Planned" }   // optional, validated like api_set_field
  } }
// →
{ "version": 46, "changed": true, "item": { "id": "k3j9x0a1b2c3", "typeId": "…", "pos": 14.5, … } }
```

The item lands on the timeline named by `timelineName` / `timelineId`, else
on the section's timeline, else on the project's first timeline. When a
timeline is named, `sectionName` is looked up on that timeline only, so
sections may share a name across timelines.

Position when `pos` is omitted: right after the last item inside the section
(clamped to the section's end), at the section's start when the section is
empty, and after the last item on that timeline when no section is given.
Name lookups (`typeName`, `timelineName`, `sectionName`) are case-insensitive
and must be unique; when two sections share a name the error lists their ids
so you can pass `sectionId` (or name the timeline) instead.

### `api_create_field`

Create a field, optionally inside a composite, in a folder, and attached to
types and/or hierarchy levels in one go. This is the one part of the schema
the token may grow: a tool that needs somewhere to store its own data (an
*Asset GUID* text field, a *Verified* toggle) can make it itself.

```jsonc
{ "p_api_token": "…", "p_author": "Unity",
  "p_field": {
    "name": "Asset GUID",            // required
    "kind": "text",                  // text | int | float | toggle | select | ref | group; default text
    "help": "Set by the Unity plugin",   // any setting api_update_field accepts (below)
    "attach": ["Checkpoint", "Level"],   // optional: type or level ids / names (types are tried first)
    "folder": "Production",          // optional: field folder id or name
    "group": "Asset"                 // optional: composite id or name to file it into
  } }
// →
{ "version": 47, "changed": true, "field": { "id": "…", "name": "Asset GUID", "kind": "text", … } }
```

A field filed into a `group` is attached through its group, so `group` and
`attach` exclude each other. A `group` kind field is created empty; add
children with further `api_create_field` calls naming it in `group`. The
new field gets the same defaults the app uses.

### `api_update_field`

Change a field's settings. Everything the app's field editor offers is
accepted except what changes the field's identity or place: `id`, `kind`,
`children`, `parentId` and `folderId` are refused (use the app).

```jsonc
{ "p_api_token": "…", "p_field_id": "<field id>", "p_author": "Unity",
  "p_patch": { "options": ["Planned", "In progress", "Done", "Shipped"], "defaultValue": "Planned" } }
// →
{ "version": 48, "changed": true, "field": { … } }
```

Accepted keys and shapes:

| key | shape |
|-----|-------|
| `name` | non-empty string |
| `help`, `unit` | string |
| `formula` | string (expression; makes the field derived, `""` makes it stored again; not on a `group`) |
| `template` | string (`group` only; `{Child}` placeholders) |
| `required`, `showInTooltip`, `showName`, `selectMultiple`, `refMultiple`, `refShowLinks`, `badge` | boolean |
| `min`, `max`, `decimals`, `maxLength` | number or null |
| `options` | array of strings (blanks and duplicates dropped) |
| `refTargets` | array of type / level ids |
| `defaultValue` | validated like `api_set_field` against the *new* settings; not on a `group` |

Changing `options` does not rewrite stored values; a stored value that is no
longer an option reads as unset in the app, exactly as when the option is
removed in the editor. Derived values simply recompute.

## Recipes for the Unity tool

**Validate the open scene.** `api_read` once. Find the section at the *Level*
depth whose name equals the scene name. Collect items on the same timeline
with `section.start <= pos < section.end` whose type is *Checkpoint*. For each,
look for a matching object in the scene (by `item.title`, or by an id you
stored in `item.link` or a text field). Warn about the ones that are missing.
Optionally offer *Add to timeline* for scene checkpoints that have no item,
via `api_create_item`.

**Mark an item done.** The tool's settings hold a field id and an option name
picked from `api_schema` (a `select` field, say *Progress*, and the option
*Done*). The button calls
`api_set_field(p_entity_id: item.id, p_field_id: progressFieldId, p_value: "Done")`.

**Stay fresh.** Call `api_version` when the window gets focus; refetch with
`api_read` only when `version` changed.

**List what is left to do.** `api-query` with
`p_query: "type = Checkpoint and Implemented = no"` returns the ids; resolve
them in the `api_read` document you already hold. Add `p_compute: true` to
read the *Remaining scope* processor of every level without re-implementing
its math.

**Keep the plugin's own data on the timeline.** On first run, look for a
text field named *Asset GUID* in `api_schema`; when it is missing, create it
with `api_create_field` attached to the types you care about, then store the
id in the tool's settings.

## Limits and notes

- One token per project, held by the project owner. There is no per-token
  scoping; rotate it if it leaks.
- The API never deletes, and never creates, renames or removes timelines,
  types, hierarchy levels or layers, or moves items between them. Fields are
  the exception: it can create them and change their settings, but not their
  kind or their place in a composite or folder. Do the rest in the app, where
  references are checked.
- Large documents: `api_read` returns everything, including inline images on
  projects that were never shared before images moved to storage. Use
  `api_schema` and `api_version` for the frequent calls.
- Concurrency: the app's autosave is version-checked. A tab whose copy is
  older than an API write cannot overwrite it; the tab pulls the new document,
  replays its own pending edits on top, and saves again. Two edits to the very
  same entity within a couple of seconds still resolve to whichever came last.
- The functions live in `supabase/migrations/0004_api.sql`; timelines were
  added in `0008_timelines.sql`, folders, composites, derived fields,
  processor conditions and the field functions in
  `0009_fields_schema_api.sql`. `api-query` is
  `supabase/functions/api-query/` (bundled from the app's sources by
  `npm run build:api`).
- The same read side is available from the command line: the agent CLI
  (`npx tsx agent/timeline.ts query --where "…"`, or the `timeline-agent`
  plugin) evaluates the same expressions locally on a document fetched
  through a share link, no API token needed.
