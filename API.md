# Timeline Planner API

A small HTTP API for external tools, built for a Unity editor plugin: read a
shared timeline, set field values (for example a *Progress* dropdown), add and
remove tags, edit an item's text, and create items. It is deliberately narrow.
The API token cannot change the schema (types, fields, hierarchy levels),
delete anything, move items, or manage share links; those stay in the app.

Everything is a Postgres function exposed through Supabase's REST layer
(PostgREST), so any HTTP client works: `UnityWebRequest`, `HttpClient`, curl.

## Getting a token

1. Share the timeline (toolbar → Share). Only the owner of a shared timeline
   sees the **API token** row.
2. Click **Create API token**. Copy it. **Rotate** invalidates the old token
   and mints a new one; **Revoke** removes it (create a new one later).

Keep the token out of version control. It grants write access to the timeline
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

- `doc.sections`: `{ id, name, depth, start, end, fieldValues }`. `depth`
  indexes `doc.hierarchyLevels` (0 = Chapter, 1 = Level, … as named in the
  project). **Match a scene by section name**: the section at the *Level*
  depth whose `name` equals the scene name.
- `doc.items`: `{ id, typeId, pos, duration, title, description, tags, link,
  fieldValues, pathId }`. An item belongs to a section when
  `section.start <= item.pos < section.end` (sections nest, so an item is in
  one section per depth). `pathId` is non-null for items on a branch path.
- `doc.types`: `{ id, name, icon, color, fields: [{ fieldId, defaultValue }] }`.
  Resolve `item.typeId` here to know that an item is a *Checkpoint*.
- `doc.fields`: field definitions (below). `item.fieldValues` is keyed by
  field **id**, and holds only explicitly set values; when a key is missing,
  the effective value is the type attachment's `defaultValue`, else the
  field's `defaultValue`, else unset.

Value shapes in `fieldValues`, by field `kind`:

| kind     | stored as                              |
|----------|----------------------------------------|
| `text`   | string                                 |
| `int`    | number (integer)                       |
| `float`  | number                                 |
| `toggle` | boolean                                |
| `select` | array of option strings (single-choice fields still use a one-element array, e.g. `["Done"]`) |
| `ref`    | array of item/section ids              |

The app ignores `camera`, `filters`, `views` and `activeViewId` for anything
but its own UI; a tool can too.

### `api_schema`

The schema half of the document, plus every tag currently in use. Enough to
build a settings UI ("which field is *Progress*, which option means *done*")
without downloading all items.

```jsonc
// →
{
  "id": "…", "name": "…", "version": 42,
  "fields": [ { "id": "f1", "name": "Progress", "kind": "select",
                "options": ["Planned", "In progress", "Done"], "selectMultiple": false,
                "required": false, "defaultValue": null, "min": null, "max": null, "…": "…" } ],
  "types": [ { "id": "t1", "name": "Checkpoint", "icon": "Flag", "color": "#22c55e",
               "defaultLayerId": null, "fields": [ { "fieldId": "f1", "defaultValue": null } ] } ],
  "typeFolders": [ … ],
  "hierarchyLevels": [ { "id": "l1", "name": "Chapter", "fields": [], "processors": [] },
                       { "id": "l2", "name": "Level", "fields": [ … ], "processors": [] } ],
  "layers": [ { "id": "…", "name": "Critical", "…": "…" } ],
  "processors": [ … ],
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
type (items) or hierarchy level (sections); value shape or range.

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
is accepted, so position, type and layer stay under the planner's control.

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

Position when `pos` is omitted: right after the last item inside the section
(clamped to the section's end), at the section's start when the section is
empty, and after the last item on the whole timeline when no section is given.
Name lookups (`typeName`, `sectionName`) are case-insensitive and must be
unique; when two sections share a name the error lists their ids so you can
pass `sectionId` instead. New items go on the main spine (`pathId: null`).

## Recipes for the Unity tool

**Validate the open scene.** `api_read` once. Find the section at the *Level*
depth whose name equals the scene name. Collect items with
`section.start <= pos < section.end` whose type is *Checkpoint*. For each,
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

## Limits and notes

- One token per timeline, held by the timeline owner. There is no per-token
  scoping; rotate it if it leaks.
- The API never deletes. Delete in the app, where references are checked.
- Large documents: `api_read` returns everything, including inline images on
  timelines that were never shared before images moved to storage. Use
  `api_schema` and `api_version` for the frequent calls.
- Concurrency: the app's autosave is version-checked. A tab whose copy is
  older than an API write cannot overwrite it; the tab pulls the new document,
  replays its own pending edits on top, and saves again. Two edits to the very
  same entity within a couple of seconds still resolve to whichever came last.
- The functions live in `supabase/migrations/0004_api.sql`.
