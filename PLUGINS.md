# Timeline Planner — Plugin Platform & Behavioral Analytics Plugin

Companion to [DESIGN.md](DESIGN.md). Two parts:

- **Part A — Plugin platform.** How the app becomes extendable by toggleable,
  per-project plugins, shipped as packages, with a path for community plugins
  (modding-style).
- **Part B — Behavioral Analytics plugin.** The first plugin: export milestone
  ids, wire them to game events in the engine, import real player telemetry,
  and see median timings, reach rates, drop-off, deaths and pacing directly on
  the timeline.

Part C is the decision log: every design choice, the alternatives that were
offered, and which one was picked in the 2026-09-08/15 review.

Written against the codebase at commit `6a80a7a` (schema v1, Vite + React 18 +
TypeScript + Zustand, single-file build into `docs/`). All a/b/c decisions
below were confirmed by the project owner; sections marked *confirmed* are
final for v1.

---

## Part A — Plugin platform

### A1. Goals and non-goals

Goals

1. Plugins are **off by default** and are enabled **per project** from a
   Project Settings dialog. Enabling is an undoable project mutation and is
   saved in the project JSON, so a shared file opens with the same plugins on.
2. Plugins are **packages**: one folder = one plugin, with a manifest, an entry
   module, and (optionally) its own styles, workers and tests. First-party
   plugins live in this repo under `plugins/`; community plugins are the same
   shape, loaded at runtime.
3. The host exposes a **small, versioned, typed API** (`PluginContext`) and a
   fixed set of **extension slots** (badges on items, tooltip/inspector
   sections, sidebar panels, toolbar buttons, export/import actions, canvas
   layers, settings panes, commands). Plugins never reach into React
   internals, the Zustand store, or the DOM of the host.
4. The **single-file build** (`docs/index.html`, opens from disk) keeps
   working. Bundled plugins are compiled in; external plugins load as ES
   modules from a file or URL without a build step on the user's side.
5. **Core stays generic.** Nothing game-specific enters `src/`; game concepts
   (runs, deaths, milestones) live only inside the analytics plugin.

Non-goals (v1)

- No sandboxing and no permission prompts for external plugins. A plugin runs
  with the same rights as the app, classic modding style (see A9).
- No plugin-to-plugin dependencies.
- No remote plugin registry service. A static JSON index on GitHub Pages is
  enough (A8).

### A2. Concepts and vocabulary

| Term | Meaning |
| --- | --- |
| Plugin | A package with a manifest and an entry module exporting a `PluginDefinition`. |
| Installed | Known to the app (bundled, or added by the user). App-wide, stored in localStorage. |
| Enabled | Switched on for one project. Stored in `project.plugins[id].enabled`. |
| Activation | The host calls `activate(ctx)` for every enabled plugin of the active project; `deactivate()` when it is turned off, the project switches, or the tab closes. |
| Contribution | Something a plugin adds to a slot (a badge renderer, a sidebar panel, an export action). Declared in the `PluginDefinition`, rendered by the host. |
| Plugin project state | Small, JSON-serialisable per-project state (`settings`, `data`). Lives inside the project document; undoable. |
| Plugin storage | Bulky per-project data (datasets) kept in IndexedDB, outside the project JSON; not undoable; exportable. |
| SDK | The `@timeline-planner/plugin-sdk` types (`sdk/`), published so community authors get typings without cloning the app. |

### A3. Package layout

```
timeline-planner/
├─ src/                       # host app (unchanged responsibilities)
│  ├─ plugins/                # NEW: host-side plugin runtime
│  │  ├─ api.ts               # PluginDefinition, PluginContext, slot types (re-exported by the SDK)
│  │  ├─ registry.ts          # bundled plugin discovery (import.meta.glob) + external loader
│  │  ├─ runtime.ts           # activation lifecycle, per-project instances, event bus
│  │  ├─ storage.ts           # IndexedDB wrapper scoped by (pluginId, projectId)
│  │  ├─ slots.tsx            # <Slot name="…"/> components the host UI renders
│  │  └─ ProjectSettings.tsx  # the Project Settings modal (Plugins tab lives here)
│  └─ …
├─ plugins/                   # NEW: first-party plugin packages, one folder each
│  └─ behavioral-analytics/
│     ├─ plugin.json          # manifest
│     ├─ index.ts             # `export default definePlugin({...})`
│     ├─ worker.ts            # aggregation worker (inlined at build time)
│     ├─ ui/…                 # React components for the slots
│     ├─ model/…              # parsing, mapping, aggregation (pure, testable)
│     └─ styles.css
├─ sdk/                       # NEW: types + tiny helpers published for community plugin authors
│  ├─ package.json            # name: @timeline-planner/plugin-sdk
│  └─ index.ts                # re-exports src/plugins/api.ts types, definePlugin()
└─ examples/hello-plugin/     # NEW: minimal external plugin (manifest + one ES module), used in docs
```

Bundled plugins are discovered at build time:

```ts
// src/plugins/registry.ts
const bundled = import.meta.glob('../../plugins/*/index.ts', { eager: true })
```

This keeps the single-file build: plugin code is part of the bundle, but a
plugin contributes nothing until enabled, and everything heavy (workers,
parsers) is only instantiated on activation.

### A4. Manifest (`plugin.json`)

```jsonc
{
  "id": "behavioral-analytics",        // stable, lowercase, kebab-case, globally unique
  "name": "Behavioral Analytics",
  "version": "0.1.0",                  // semver; the host shows it, data migrations key off it
  "apiVersion": 1,                     // host plugin API major version this was built for
  "description": "Overlay real player telemetry (median timings, reach %, drop-off, deaths) on timeline items.",
  "author": "Timeline Planner",
  "homepage": "https://github.com/itsmas/timeline-planner",
  "entry": "index.js",                 // relative to the manifest (external plugins only)
  "icon": "Activity",                  // Lucide icon name, shown in the settings list
  "permissions": ["storage", "network", "worker", "export", "import"],
  "minHostVersion": "0.2.0"
}
```

`permissions` is purely descriptive metadata in v1: it is listed on the
plugin's row in Project Settings so users can see what a plugin does, but
nothing is gated and no prompt is shown (decision C1.4). The host refuses to
load a plugin whose `apiVersion` is greater than the host's, and warns (but
loads) when it is lower.

### A5. Host API: `PluginDefinition` and `PluginContext`

Everything a plugin can do goes through these two types. They are the public
contract; changing them in a breaking way bumps `apiVersion`.

```ts
// src/plugins/api.ts (abridged; the file is the source of truth)
export const PLUGIN_API_VERSION = 1

export interface PluginDefinition {
  manifest: PluginManifest
  /** Called when the plugin is enabled for the active project (or on load if already enabled). */
  activate(ctx: PluginContext): void | Promise<void>
  /** Called on disable, project switch, or unload. Must release workers/timers. */
  deactivate?(): void
  /** Migrate `project.plugins[id]` state written by an older plugin version. */
  migrate?(state: unknown, fromVersion: string): PluginProjectState
  /** Static contributions. All optional; the host renders them only while enabled. */
  contributes?: {
    settingsPanel?: React.ComponentType<{ ctx: PluginContext }>
    sidebarPanels?: SidebarPanelContribution[]
    toolbarButtons?: ToolbarButtonContribution[]
    exportActions?: MenuActionContribution[]      // appear in the Export/Import menu
    importActions?: MenuActionContribution[]
    commands?: CommandContribution[]              // keyboard-shortcut-able actions; listed in the "?" cheatsheet
    itemDecorations?: (ctx: PluginContext, item: Item, view: ItemViewInfo) => ItemDecoration[]
    tooltipSections?: React.ComponentType<{ ctx: PluginContext; item: Item }>[]
    inspectorSections?: InspectorSectionContribution[]     // for item / bulk / branch / section panels
    canvasLayers?: CanvasLayerContribution[]               // SVG rendered in scene space, above or below the spine
    projectTransform?: (ctx: PluginContext, project: Project) => Project | null  // view-only remap (e.g. time-warp)
    exportSceneDecorations?: (ctx: PluginContext, item: Item) => ItemDecoration[] // for PNG/SVG export parity
  }
}

export interface PluginContext {
  pluginId: string
  hostVersion: string
  /** Current project snapshot (readonly). Re-read on every render/event; never cache across mutations. */
  project: () => Readonly<Project>
  /** Plugin's own slice of the project: { enabled, settings, data }. */
  state: () => PluginProjectState
  /** Undoable write to the plugin's slice (goes through the host `mutate`). */
  setState: (recipe: (s: PluginProjectState) => void, opts?: { undoable?: boolean }) => void
  /** Undoable write to the whole project — for plugins that need to touch items (e.g. set item.key). */
  mutateProject: (recipe: (p: Project) => void) => void
  /** Bulky, non-undoable storage in IndexedDB, scoped to (pluginId, projectId). */
  storage: PluginStorage
  /** Host UI services. */
  ui: {
    toast: (msg: string, opts?: { undo?: boolean }) => void
    select: (ids: string[]) => void
    flyToItem: (id: string) => void
    openModal: (node: React.ReactNode, opts?: { title?: string; width?: number }) => () => void
    theme: () => 'dark' | 'light'
    formatPos: (pos: number) => string
  }
  /** Subscribe to host events; returns unsubscribe. */
  on: <K extends keyof HostEvents>(event: K, handler: (e: HostEvents[K]) => void) => () => void
  /** Plain fetch; browser same-origin/CORS rules apply. Listed here so plugins have one obvious door. */
  net: { fetch: typeof fetch }
  /** Spawn a Web Worker from source text (host inlines it as a Blob URL so the single-file build works). */
  worker: (source: string | (() => Worker)) => Worker
  /** Host-provided React so external plugins never bundle their own copy. */
  React: typeof React
  util: { uid: () => string; download: (name: string, blob: Blob) => void; csv: CsvHelpers }
}

export interface PluginProjectState {
  enabled: boolean
  version: string                 // plugin version that last wrote this state
  settings: Record<string, unknown>
  data: Record<string, unknown>   // small per-project data (mappings, dataset index, per-item keys)
}

export interface HostEvents {
  projectChanged: { project: Project; reason: 'mutate' | 'tweak' | 'undo' | 'redo' | 'import' | 'switch' }
  selectionChanged: { ids: string[] }
  itemsDeleted: { ids: string[] }
  beforeExport: { kind: 'json' | 'png' | 'svg' }
}

export interface ItemDecoration {
  kind: 'badge' | 'tint' | 'ring' | 'marker'
  text?: string                   // badge
  color?: string                  // tint/ring/badge accent
  intensity?: number              // 0..1 for tint
  title?: string                  // hover text
  priority?: number               // when several plugins decorate, higher wins the visible slot
}

export interface ItemViewInfo { labelShown: boolean; ghost: boolean; zoom: number; onPath: boolean }
```

Slot rendering rules (host side):

- **Badges** render as a pill below the node at the row position, only when the
  item's label is shown (same LOD gate as titles), max two badges per item;
  at low zoom only `tint`/`ring` decorations survive. Decorations are pure
  functions of `(project, plugin state)` and are memoised per item per render.
- **Tooltip sections** render after the description, in plugin order.
- **Inspector sections** render as collapsible groups after the built-in
  fields, remembering open/closed state per plugin.
- **Sidebar panels** become collapsible sections like Types/Layers, appended
  after Tags, with the plugin icon.
- **Toolbar buttons** are appended before the export button; they can be
  `toggle` (with `active()` state) or `action`.
- **Canvas layers** receive `{ toX, toPos, width, height, spineY, camera,
  layout }` and return SVG; `placement: 'below-spine' | 'above-spine' |
  'background'`. Layers must not attach pointer handlers that swallow host
  gestures except inside their own bounding rect.
- **projectTransform** lets a plugin present a derived project (positions,
  durations, section bounds) to the canvas/layout only. The host marks the
  canvas read-only while any transform is active (no drag/edit), shows a
  banner ("Viewing: Time-warp — editing disabled"), and never persists the
  transformed data. The Canvas already has an "effective project" concept for
  drag previews; the transform plugs in at the same point.
- **Export parity:** `exportSceneDecorations` (or, by default,
  `itemDecorations`) are drawn by `ExportScene` so PNG/SVG exports show badges
  and tints.

### A6. Project schema changes

Additive and optional; `schemaVersion` stays `1`. Existing files load
unchanged; consumers that ignore unknown keys are unaffected.

```jsonc
{
  "schemaVersion": 1,
  // …existing fields…
  "plugins": {                              // NEW, optional
    "behavioral-analytics": {
      "enabled": true,
      "version": "0.1.0",
      "settings": { "timeFormat": "mm:ss", "badgeMetrics": ["median", "reach"] },
      "data": { "datasets": [ { "id": "…", "name": "Playtest 3", "runs": 1842, "importedAt": "…" } ],
                "activeDatasetId": "…", "mappings": { "boss_1": "<itemId>" } }
    }
  },
  "items": [ { "id": "…", "key": "boss_1_defeated", /* NEW optional human-readable stable key */ … } ]
}
```

Rules

- `plugins[id].enabled === true` is the only source of truth for "on".
  Missing key = off. Unknown plugin ids are preserved untouched on load/save
  so a file round-trips through an app that lacks that plugin.
- `items[].key` is a core field (not plugin-owned) because several plugins
  will want a stable human-readable id; the core Inspector gets a small "Key"
  input under Link. Uniqueness is validated (warn, do not block).
- Undo/redo and version snapshots already serialise the whole project, so
  plugin `settings`/`data` are covered for free.
- `importProject` must not strip `plugins`; `exportJSON` writes it as is.
- Bulky plugin storage (A7) is **not** in the project JSON. The Export menu
  gets "Project JSON + plugin data (.zip)" in phase 2 so a project can move
  machines with its datasets (A11).

### A7. Storage

`PluginStorage` wraps IndexedDB (database `tp-plugins`, store keyed by
`${pluginId}/${projectId}/${key}`), with `get/set/delete/list/estimate`.
Values can be JSON or `ArrayBuffer`/typed arrays (structured clone). The
host deletes a project's plugin storage when the project is closed with
"delete", and offers "Remove plugin data" in Project Settings when a plugin is
disabled. localStorage is never used for plugin data (5 MB quota).

### A8. Loading external (community) plugins

Phase 2 of the platform, but designed in from the start.

- **Sources:** (1) a local folder/file picker (`plugin.json` + entry `.js`),
  (2) a URL to a `plugin.json` (the entry is resolved relative to it),
  (3) a curated index `https://itsmas.github.io/timeline-planner/plugins.json`
  listing community plugins (name, description, manifest URL, author, tags).
- **Loading:** the host fetches the entry source, stores it (IndexedDB,
  `installed/<id>`), and runs `import(URL.createObjectURL(new Blob([src],
  {type:'text/javascript'})))`. This works from `file://` and from the
  single-file build. The module must `export default` a `PluginDefinition`.
- **React:** external plugins must not bundle React. They use `ctx.React` (or
  `ctx.React.createElement`/`htm`). The SDK ships an esbuild example config
  marking `react`/`react-dom` external and aliasing them to a tiny shim that
  reads from `globalThis.__tpReact`, which the host sets before importing.
- **Upgrades:** re-installing the same `id` with a higher version replaces
  the source; `migrate()` runs on the next activation per project.
- **Install UI:** the install dialog shows manifest name, version, author,
  homepage and the descriptive permissions list, with a single Install
  button. No warnings or consent steps (C1.4). Community index entries carry
  a `verified` flag set by the repo maintainers, shown as a badge.

### A9. Security posture (confirmed: fully trusted)

- Plugins are fully trusted code, like game mods. All data is local-first, so
  the blast radius of a bad plugin is the user's browser storage for this
  origin.
- The README and the community index page state this plainly: install
  plugins only from sources you trust.
- Nothing is gated at runtime. If the community grows, a sandboxed
  `<iframe>` + postMessage variant of `PluginContext` can be added later
  without changing the plugin API surface for well-behaved plugins.

### A10. Host UI changes

1. **Project Settings modal** (new). Opened by a gear button in the toolbar
   (right of the tabs) or `Ctrl+,`. Tabs: *General* (name, hierarchy levels
   moved here from the sidebar's Structure section — the sidebar keeps the
   quick editor), *Plugins*, *Data* (storage usage, snapshots, "delete
   plugin data").
2. **Plugins tab:** one row per installed plugin: icon, name, version,
   description, descriptive permission chips, **toggle** (off by default),
   gear to open `settingsPanel` (only when enabled). Footer: "Add plugin…" (file/URL) and
   "Browse community plugins" (index). Toggling calls `mutate`
   (undoable) and then the runtime activates/deactivates.
3. **Slots** rendered in: `Sidebar` (after Tags), `Toolbar` (before export),
   export menu, `Inspector` panels, Canvas tooltip and scene, cheatsheet
   (commands), `ExportScene`.
4. **Read-only banner** while a `projectTransform` is active.
5. The `?` cheatsheet lists plugin commands under a heading per plugin.

### A11. Runtime lifecycle

```
load app ─► registry.discover() ─► for active project: for each plugin with enabled=true
        ─► instantiate ctx ─► migrate() if version differs ─► activate(ctx)
switch project ─► deactivate() all ─► (repeat activation for the new project)
toggle off ─► deactivate() ─► contributions unmount ─► state.enabled=false (undoable)
toggle on  ─► state.enabled=true ─► activate(ctx)
undo across a toggle ─► runtime diffs enabled set after every project change and reconciles
```

Rules: activation errors are caught, shown as a toast and in the Plugins
tab ("Failed to activate — see console"), and never break the host.
Contributions of a plugin that threw during render are unmounted (error
boundary per slot).

### A12. Developer experience

- `npm run dev` hot-reloads bundled plugins like any source.
- `sdk/` is published as `@timeline-planner/plugin-sdk` with types,
  `definePlugin()`, CSV helpers and an example esbuild config.
- `examples/hello-plugin` adds a badge "👋" to every item and a sidebar panel
  counting items; it doubles as the loader's smoke test.
- Tests: pure model code of plugins (parsers, aggregation) gets unit tests
  with Vitest (dev dependency to add). The host runtime gets a small test for
  the activation/reconcile logic. UI stays manually verified, per DESIGN Q72.

### A13. Build order (platform)

1. `api.ts`, `runtime.ts`, `registry.ts` (bundled only), `storage.ts`,
   project schema additions (`plugins`, `items[].key`), Project Settings
   modal with the Plugins tab.
2. Slots: item decorations (canvas + export), tooltip, inspector, sidebar,
   toolbar, export/import menu, commands, canvas layers.
3. `projectTransform` + read-only banner.
4. External loader (file/URL), install/trust dialog, community index,
   `sdk/` package, `examples/hello-plugin`.
5. "Project JSON + plugin data" zip export/import.

---

## Part B — Behavioral Analytics plugin

### B1. The loop it enables

```
Design the timeline ──► Export milestones (CSV/JSON with ids)
      ▲                              │
      │                              ▼
Import telemetry ◄── Collect runs ◄── Engine tool maps game events ⇄ milestone ids
```

1. The designer plans the game as a timeline (e.g. *Boss 1 defeated*, *Boss 2
   defeated*).
2. **Export → Milestones CSV** writes one row per item with the stable `id`
   (and optional human `key`).
3. In the engine, a small tracker maps in-game events to those ids and emits
   `(run_id, milestone_id, t_seconds)` records to whatever telemetry sink the
   studio uses.
4. After a playtest, the designer exports the collected events (CSV or JSON)
   and **imports** them into the plugin as a named dataset.
5. The plugin maps events back to items by id and shows **median time to
   reach, spread, reach rate, drop-off, deaths, pacing** on the timeline, in
   tooltips, in the inspector and in an analytics panel.
6. The designer narrows everything to a **run cohort** (B6a): runs that
   reached a chosen milestone, runs that took the red-pill path, runs that
   completed an ALL branch in a given order, runs on a given build.
7. Optionally the designer **bakes** the measured timings back into the plan
   (B8a): positions become median seconds, or the timings of one chosen run,
   after a preview shows how far every item would move.

### B2. Export: milestones

Menu entries (contributed to the Export menu): **Milestones CSV**,
**Milestones JSON**. Both honour the current filters when the "only visible
items" checkbox is on (default off — export everything, telemetry should not
depend on a view).

CSV columns (UTF-8, comma-separated, RFC 4180 quoting, header row):

| column | meaning |
| --- | --- |
| `id` | item id. **Canonical join key.** |
| `key` | `item.key` or empty. Human-readable, optional. |
| `title` | item title |
| `type` | type name |
| `layer` | resolved layer name |
| `pos` | abstract position (float) |
| `duration` | 0 for points |
| `order` | 1-based index in timeline order (main line by `pos`; path items after their fork, by `pos`) |
| `line` | `main` or the branch path id |
| `path_label` | branch path label if any |
| `branch_id`, `branch_mode` | for path items |
| `section_path` | `Chapter 1 › Tutorial cave › First steps` |
| `tags` | `;`-joined |
| `target_time_s` | the designer's expected time, from the plugin's per-item setting (B7), if set |
| `project_id`, `exported_at` | repeated on every row for traceability |

JSON (`*.milestones.json`) carries the same data as `{ format:
"tp-milestones/1", projectId, projectName, exportedAt, milestones: [...] }`
plus `branches` and `sections` so an engine tool can show structure.

Item `key` UX: the plugin's inspector section shows a **Key** field with an
auto-suggested slug from the title (`boss_1_defeated`), a "generate keys for
all items" command, and a duplicate warning. Keys are core data (A6) so they
survive the plugin being disabled.

### B3. Engine contract (engine-agnostic)

The plugin does not ship engine code, but the spec fixes the contract so any
engine tool can be written against it. Minimal event record:

```
run_id        string   unique per playthrough attempt (a new run on "New game"/restart from start)
milestone_id  string   the exported `id` (or `key`; both accepted at import, id wins)
t             number   seconds since the run started (gameplay time preferred; pauses excluded)
kind          string   optional; default "reach". Also: "death", "attempt", "custom"
value         number   optional; free numeric payload (damage taken, score…) for "custom"
player_id     string   optional; hashed/pseudonymous id to group runs
ts            string   optional; ISO 8601 wall clock, for date-range cohorts
```

Optional run record (one per run):

```
run_id, player_id, started_at, ended_at, duration_s, build, platform, difficulty,
outcome (completed|quit|crash|unknown), …any extra columns become cohort dimensions
```

Reference tracker (pseudo-code, any engine):

```
class MilestoneTracker
  load(milestones.json)             // id → {key,title}
  startRun()                        // run_id = uuid, t0 = now
  reach(idOrKey)                    // first time only → emit(run_id, id, elapsed, "reach")
  death(idOrKey)                    // emit(..., "death"); reach() may follow on success
  endRun(outcome)                   // emit run record
```

Recommendations to document in the plugin's help panel: use gameplay time
(pause excluded), emit `reach` once per run per milestone, emit a run record
even for abandoned runs (so reach % has a true denominator), hash player ids.

Branch paths need no engine support (decision C2.21, *inference only*): a run
is considered to have taken a path when it reached any milestone placed on
that path, and the order of ALL-branch paths is derived from the earliest
reach time on each path. The practical consequence for designers: **every
path that should be measurable needs at least one item on it** (a
checkpoint, a story beat, anything). The branch inspector warns when a path
has no mapped milestone.

### B4. Import: telemetry

Menu entry: **Import telemetry…** (also drag-and-drop a file onto the
Analytics sidebar panel). Accepted inputs, auto-detected by header/shape:

1. **Events CSV** (canonical, long format): columns from B3. Extra columns are
   ignored with a notice.
2. **Runs CSV**: header contains `run_id` and none of `milestone_id`/`t`.
   Merged into the dataset's run table.
3. **Wide CSV**: one row per run; header = `run_id` + milestone ids/keys;
   cells = seconds or empty. Converted to events on import.
4. **JSON bundle**: `{ format: "tp-telemetry/1", runs?: [...], events: [...] }`.
5. **Multiple files** can be added to the same dataset (append), e.g. one file
   per day. Duplicate `(run_id, milestone_id, kind)` keep the earliest `t`.

Import flow (modal):

1. Pick file(s) → streamed parse in a worker (chunked `File.stream()`, so a
   500 MB CSV does not block the UI). Progress bar with rows/s.
2. **Preview & mapping step.** Table: milestone ids found, event count, and
   match status: *matched by id*, *matched by key*, *unmatched*. Unmatched
   ids can be mapped to an item (searchable dropdown), ignored, or left for
   later; mappings persist in `state.data.mappings` (undoable) so re-imports
   auto-apply. Also shows: run count (from run records, else distinct
   `run_id`), date range, dimension columns detected.
3. **Dataset naming:** new dataset (name defaults to file name) or append to
   an existing one. Datasets live in `ctx.storage`; the index (id, name, run
   count, imported at, source file names, dimension names) lives in
   `state.data.datasets`.
4. Done → toast with counts; the new dataset becomes active.

Validation and edge cases

- `t < 0`, non-numeric, or `> 10 years` → row dropped, counted in the report.
- Same milestone reached several times in a run → first `t` is the reach;
  extra reaches count as `attempts`.
- Runs with events but no run record are created implicitly with unknown
  dimensions.
- Milestones that exist in the data but not in the timeline stay in the
  dataset (never lost) and show in the *Unmapped* list; mapping later
  recomputes aggregates.
- Items deleted after import become unmapped; deleting an item warns when
  the active dataset has data for it.
- Encoding: UTF-8 (BOM tolerated). Delimiter auto-detected (`,` `;` `\t`).

### B5. Dataset model (in `ctx.storage`)

Compact columnar layout so aggregation is fast and memory is predictable:

```ts
interface DatasetBlob {
  format: 1
  milestoneIds: string[]                  // column index → milestone id as seen in the data
  runs: { id: string; playerId?: string; startedAt?: number; dims: Record<string, string>; outcome?: string; durationS?: number }[]
  reachT: Float32Array                     // runs.length × milestoneIds.length, NaN = never reached
  deaths: Uint16Array                      // same shape, count of "death" events
  attempts: Uint16Array                    // same shape
  custom?: Record<string, Float32Array>    // per custom event name
  dimValues: Record<string, string[]>      // for cohort chips
}
```

Derived at aggregation time (not stored): for every branch, per run, the
path taken (ANY) or the completion order (ALL), inferred from `reachT` of
the items on each path. Recomputed whenever items move between paths.

Sizing: 200 000 runs × 100 milestones × 4 B ≈ 80 MB for `reachT`; plus two
Uint16 planes ≈ 80 MB. Within IndexedDB limits but large; the import step
warns above 100 MB and offers "store aggregates only" (drops per-run arrays,
keeps t-digest sketches per milestone per dimension value — loses arbitrary
cohort combinations, keeps single-dimension cohorts).

### B6. Aggregation

Runs in a worker (`plugins/behavioral-analytics/worker.ts`), triggered on:
dataset change, cohort filter change, mapping change, item order change
(debounced). Results cached by `(datasetId, cohortKey, mappingHash,
orderHash)`.

Per milestone (mapped item), for the active cohort's runs `R` (B6a; with no
cohort, `R` = all runs of the dataset):

| metric | definition |
| --- | --- |
| `n` | runs in `R` that reached the milestone |
| `reach` | `n / |R|`. With a funnel start set, `R` already contains only runs that reached it, so reach is relative to the start |
| `stepReach` | `n / n_prev` where `prev` is the previous mapped milestone in timeline order on the same line (main line, or the path's own sequence; the first item on a path uses the fork's previous main-line milestone) |
| `dropoff` | `1 − stepReach` |
| `tMedian`, `tP10`, `tP25`, `tP75`, `tP90`, `tMean`, `tMin`, `tMax`, `tStd` | over reach times of the `n` runs, after outlier policy (B7); rebased to the funnel start when `rebaseTimes` is on |
| `iqr`, `spread` | `tP75 − tP25`, and `tP90 − tP10`; drive the whisker/halo visuals (B8b) |
| `segMedian` | median of `(t − t_prev)` per run, over runs that reached both |
| `deaths`, `deathsPerRun` | sum / `n` (deaths of runs that never reached it still count, divided by runs that *attempted* = reached prev) |
| `attempts` | mean extra reaches |
| `targetDelta` | `tMedian − target_time_s` when a target is set |

Per section: reach at section end (last milestone inside), median enter/exit
time (first/last mapped milestone in the section), runs lost inside the
section (`n_first − n_last`).

Per branch (inference from path items, B3): **ANY** → for each path, the
number and share of runs whose first reached path-item is on that path; runs
that touched several paths are attributed to the path they reached first and
counted in a `mixed` figure shown in the inspector. **ALL** → every observed
completion order (sequence of paths by earliest reach time), with count and
share, plus "first path" shares and per-path median completion time. Runs
that completed only some paths are listed as partial orders (`Red → …`).
Nested branches report shares conditional on the parent path.

Global: total runs, completed runs (reached the last milestone or
`outcome=completed`), median run length, histogram of last milestone reached
(the "where do players quit" chart).

Histograms: 24 bins between p1 and p99 of the reach time per milestone,
computed in the same pass.

### B6a. Run cohorts (confirmed)

A **cohort** is a saved or transient set of predicates over runs. Predicates
are ANDed; predicates of the same kind on the same target are ORed (e.g. two
builds). Every indicator (badges, tint, whiskers, lane, tooltips, inspector,
section and branch labels, funnel table, reports) is computed for the
active cohort. Cohorts live in `state.data.cohorts` (named) and
`state.data.activeCohort` / `compareCohort` (undoable).

```ts
type Predicate =
  | { kind: 'reached'; milestoneId: string }             // run reached this milestone
  | { kind: 'notReached'; milestoneId: string }
  | { kind: 'funnelStart'; milestoneId: string }         // like `reached`, and also the origin for reach % and (optionally) times
  | { kind: 'funnelEnd'; milestoneId: string }           // milestones after it are excluded from the funnel table
  | { kind: 'path'; branchId: string; pathId: string }   // ANY branch: run took this path
  | { kind: 'firstPath'; branchId: string; pathId: string } // ALL branch: this path was completed first
  | { kind: 'order'; branchId: string; pathIds: string[] }  // ALL branch: exact completion order (prefix match allowed)
  | { kind: 'dim'; name: string; values: string[] }      // runs CSV dimension, e.g. build ∈ {0.4.1, 0.4.2}
  | { kind: 'outcome'; values: ('completed' | 'quit' | 'crash' | 'unknown')[] }
interface Cohort { id: string; name: string; predicates: Predicate[]; color?: string }
```

Where cohorts are built (all three, decision C2.22):

- **Item inspector → Analytics section:** buttons *Use as funnel start*,
  *Use as funnel end*, *Only runs that reached this*, *Only runs that did
  not reach this*. The funnel-start item gets a small flag glyph on the
  canvas.
- **Branch inspector → Analytics section:** the distribution table (see
  below). Each path row (ANY) or order row (ALL) has a *Filter* button that
  adds the predicate; clicking an already-active row removes it.
- **Sidebar Analytics panel → Cohort builder:** chips for every active
  predicate with ×; *Add predicate…* opens a picker (milestone search,
  branch/path picker, dimension values); *Save as…* names the cohort;
  saved cohorts appear as chips, like Views, and a saved cohort can be set
  as **A** (active) or **B** (compare).
- **Canvas:** Alt-click a branch path line or label → solo that path's runs
  (adds a `path`/`firstPath` predicate; Alt-click again removes it), the
  same gesture the sidebar uses to solo a type. Alt-click the funnel-start
  flag clears it.

**Cohort bar.** When any predicate is active, a slim bar under the view bar
shows the chips and `612 of 1 842 runs (33 %)`, and a *Clear* button. In
compare mode it shows `A: Red pill · 612` and `B: Blue pill · 1 187` with
their colours.

**Distributions with no filter.** The point of cohorts is also to *see*
the split before filtering:

- ANY branch on canvas: each path label gains `· 62 %`; path stroke width
  scales between 1.5 px and 4 px with share; a `mixed 3 %` note appears on
  the gate when runs touched several paths.
- ALL branch on canvas: the gate shows the top order compactly
  (`R→B→G 41 %`); each path label shows *first* share (`· 1st in 71 %`).
- Branch inspector: full table — ANY: path, runs, share, median time on
  path; ALL: every observed order with runs and share (top 10, rest
  grouped), "first path" shares, partial-order count. Both have a *Filter*
  button per row and a mini bar chart.
- Nested branches: the inner branch's table is conditional on the outer
  path when an outer `path` predicate is active, and otherwise shows a
  small "by parent path" breakdown.
- Sidebar Analytics panel: **Branch choices** section listing all branches
  with their top split, so a designer can scan the whole game's choices
  at once.

**Funnel start and time rebasing.** Setting a funnel start does two things:
`R` becomes runs that reached it (so every reach % is relative to it), and
the funnel table starts there. Times stay "since run start" unless the
**Rebase times to funnel start** toggle (sidebar panel and settings) is on;
then every time metric is `t − t_start` per run, badges say `+12:34`, and
the pacing lane origin moves to the start milestone (decision C2.23).

**Compare (A vs B).** Two cohorts may be active at once (decision C2.24).
Badges show A's value with a B delta (`12:34 · −1:20`, `84 % · +6 pp`),
tint follows the delta sign, the lane draws A solid and B dashed, the
inspector shows an A/B column pair, whiskers draw as two thin stacked
boxes. Dataset-vs-dataset comparison is the same mechanism with a
`datasetId` on the cohort (a cohort may optionally pin a dataset).

### B7. Settings (per project, in `state.settings`)

| setting | options | default |
| --- | --- | --- |
| `timeFormat` | `mm:ss`, `h:mm:ss`, `seconds`, `minutes (decimal)` | `mm:ss` |
| `badgeMetrics` | up to 2 of: median, reach, stepReach, dropoff, deaths, segMedian, targetDelta | `[median, reach]` |
| `tintMode` | `none`, `reach` (sequential), `dropoff` (diverging, red = high loss), `deaths` | `dropoff` |
| `showLane` | on/off, plus lane placement below/above spine and metric (funnel, pacing, deaths) | on, below, funnel |
| `reachDenominator` | `allRuns`, `runsWithAnyEvent` — only applies when no funnel start is set | `allRuns` |
| `rebaseTimes` | rebase time metrics to the funnel-start milestone | off |
| `spreadVisual` | `whisker` (box + whiskers under labelled nodes, halo at low zoom), `halo`, `none` | `whisker` |
| `spreadStat` | percentiles drive the visuals; σ is shown numerically | `percentiles` (fixed in v1) |
| `bakeScale` | `preserveExtent`, `unitsPerSecond:N`, `anchorFunnelStart:factor` | `preserveExtent` |
| `outliers` | `none`, `trimP99`, `capSeconds:N` | `trimP99` |
| `minSample` | integer; hide stats when `n <` | 5 |
| `showNoData` | show a faint "no data" marker on unmapped items | off |
| `perItem[itemId]` | `{ targetTimeS?: number; prevOverride?: itemId; excludeFromFunnel?: boolean; lockOnBake?: boolean }` | — |
| `live` | `{ url, headers, intervalMin }` (phase 3) | off |

### B8. Display

**Item badges** (via `itemDecorations`): pill under the node, e.g.
`12:34 · 84%`. Colour follows the type colour at low emphasis; `dropoff`
badge turns red above a threshold (default 15 pp). Hidden when `n <
minSample` (shows `n<5`). Badges follow the label LOD; at low zoom only the
tint remains so the density system is unaffected.

**Tint** (`ItemDecoration.kind = 'tint'`): the node ring/stem uses a
sequential ramp (reach) or a diverging ramp (drop-off, deaths) mixed into
the type colour at 40–70 %. Colour ramps must read in both themes.

**Analytics lane** (`canvasLayers`, `below-spine`, 84 px, collapsible):

- *Funnel*: a step curve of `reach` across x (milestones as steps), filled
  under; vertical drop bars between consecutive milestones sized by
  `dropoff`; hover shows the two milestones and the loss in runs.
- *Pacing*: `tMedian` as a line with a p25–p75 band; where a target time is
  set, a dashed target line; over-target segments hatched.
- *Deaths*: bars per milestone.
- The lane respects branch regions by drawing per-path mini-funnels inside
  the braid area when expanded.

**Tooltip section:** `median 12:34 · p25–p75 10:02–15:40 · reached 84 % ·
lost 6 % since "Boss 1" · deaths 1.8/run · n=1 542` and a 24-bin sparkline
histogram.

**Inspector section** ("Analytics", collapsible): key field, target time
input, previous-milestone override, stats table (all metrics), histogram
with p-markers, cohort breakdown table (one row per value of the selected
dimension: n, reach, median), comparison delta column when a compare dataset
is active, and "exclude from funnel" toggle.

**Sidebar panel** ("Analytics"): dataset selector + import button; cohort
filter builder (dimension → value chips; AND across dimensions, OR within);
compare-with dataset selector; badge/tint/lane quick toggles; **funnel
table** of all mapped milestones in timeline order (columns: title, n,
reach, drop-off, median; sortable; click flies to the item); **Top losses**
(5 largest drop-offs); **Unmapped** milestones with map/ignore actions;
storage size and "delete dataset".

**Section bands:** when `showSectionStats` is on, the band label gains a
suffix `· 91 % · 18:20`.

**Branch paths:** label suffix `· 62 % of runs` (ANY) or `· 1st in 71 %`
(ALL).

**Time-warp view and bake:** see B8a.

**Spread (variation) visuals:** see B8b.

**Comparison mode:** see *Compare (A vs B)* in B6a.

**Export parity:** PNG/SVG exports include badges and the lane when enabled.
"Export → Analytics report (CSV)" writes the funnel table for the current
cohort; "(Markdown)" writes a shareable summary with the top losses and
section stats.

### B8a. Time-warp view and bake (confirmed)

Two related features share one engine, the **timing source**:

```ts
type TimingSource =
  | { kind: 'median' }                       // tMedian of the active cohort
  | { kind: 'percentile'; p: number }        // e.g. p25 "fast players", p75 "slow players"
  | { kind: 'run'; runId: string }           // one specific run's actual reach times
```

and one **mapping** from seconds to timeline units (setting `bakeScale`,
decision C2.27, default *preserve extent*): the first and last mapped
milestones on the main line keep their current positions and the scale
`k = (pos_last − pos_first) / (t_last − t_first)` maps every other measured
time; unmapped items, section bounds and branch fork/join positions are
linearly interpolated between their nearest mapped neighbours (in the
original position space) so structure keeps its relative place. Items on a
branch path are mapped inside the path's own fork/join interval. Items with
`lockOnBake` never move. Items the timing source has no time for (not
reached in that run, or `n < minSample`) interpolate like unmapped items and
are flagged.

**Time-warp view** (`projectTransform`, toolbar toggle "⏱", command `T`): the
canvas shows the mapped project read-only (host banner). A small source
picker sits in the banner: *Median · p25 · p75 · Run…* (a run picker with
search by run id, player id, date, outcome, and a "random run in cohort"
button). Toggling off restores the plan instantly; nothing is written.

**Bake** (command *Bake timings into positions…*, also a button in the
banner while time-warping): writes the mapped positions into the project as
one undoable `mutateProject`. It always goes through a **preview modal**
first:

1. Source picker (same as above) and scale mode.
2. A **shift table**: one row per item — title, current `pos`, new `pos`,
   delta in units and as `%` of the item's distance to its previous
   milestone, direction glyph (◀ earlier / ▶ later), and a checkbox to
   exclude that row (keeps it where it is and interpolates neighbours).
   Sortable by absolute delta so the biggest surprises are on top. Summary
   line: `31 items move · median shift 2.4 u · largest: "The chasm" +9.1 u`.
3. A **before/after strip**: two miniature spines (current on top, baked
   below) with thin connector lines between each item's old and new x, in
   the type colour. Large shifts get a stronger connector. This is the same
   `ExportScene` renderer at small scale, so it costs nothing new.
4. *Bake* commits; *Bake and keep time-warp off* is the default; a toast
   offers Undo for 10 s like delete does.

After a bake, per-item `targetTimeS` may optionally be set to the baked
time (checkbox in the preview) so the plan now carries the measured target.

### B8b. Spread (standard deviation) visuals (confirmed)

Goal: see at a glance which milestones players hit at a consistent time
and which are all over the place, without cluttering the spine. Decisions
C2.25/26: percentiles drive the geometry (robust to the long tails timing
data always has), and σ is shown as a number.

1. **Whisker under labelled nodes** (default). When an item's label is
   shown (same LOD gate as titles and badges), a slim box-and-whisker is
   drawn just below the badge, in the type colour at 60 % opacity: the box
   spans p25–p75, whiskers p10–p90, a 1 px tick at the median. Its width is
   the spread mapped with the current `bakeScale` mapping so it is
   comparable across the line (in time-warp/bake preview it is exact
   seconds on the axis). Hovering the whisker shows `p10 · p25 · median ·
   p75 · p90 · σ · n`.
2. **Halo at low zoom** (fallback when the label is hidden). The node's
   outer ring gets a soft radial gradient whose radius grows with
   `iqr / tMedian` (relative spread), from +0 px (tight) to +10 px (very
   spread), clamped, so a zoomed-out spine reads as "sharp dots = reliable
   timing, fuzzy dots = unreliable timing". The halo is `pointer-events:
   none` and respects `prefers-reduced-motion` (no animation anyway).
3. **Smear in time-warp / bake preview.** When time-warping, each item can
   additionally draw a translucent density band along the axis from p10 to
   p90 (opacity by histogram density, 24 bins), so the whole line looks
   like a long-exposure photo of where players actually were. Toggle in
   the time-warp banner; off by default.
4. **Numbers.** Badge metric `spread` shows `±σ` (or `IQR` when
   `spreadStat` is percentiles and the user picks it), tooltip and
   inspector show σ, IQR, p10–p90 and the histogram; the funnel table has
   an IQR column and can sort by it to find the least predictable
   milestones. The lane's pacing mode already draws the p25–p75 band.
5. **Comparison.** With A/B cohorts the whisker draws as two thin stacked
   boxes (A above, B below); the halo uses A only.

### B9. Performance targets

| operation | target |
| --- | --- |
| Import 1 M events (≈ 60 MB CSV) | < 15 s, UI responsive, progress shown |
| Aggregate 200 k runs × 100 milestones | < 300 ms in the worker |
| Cohort change → badges updated | < 500 ms end-to-end |
| Canvas frame with badges + lane at 500 items | 60 fps (decorations memoised; lane path pre-computed per layout pass) |
| Memory | dataset arrays only; aggregates < 1 MB |

### B10. Privacy

Everything stays in the browser. The help panel recommends hashing player
ids before export from the engine and never including free-text. The
`live` source (phase 3) sends only the configured headers to the configured
URL and nothing else.

### B11. Build order (plugin)

1. Milestones CSV/JSON export; item `key` field + slug command.
2. Import modal: events CSV + JSON, streamed parse, mapping step, dataset
   storage; sidebar panel with dataset list and funnel table.
3. Aggregation worker; badges, tint, tooltip, inspector section; settings
   panel.
4. Analytics lane (funnel, pacing, deaths); section and branch stats.
5. Run cohorts (B6a): predicates, cohort bar, branch distributions on
   canvas and in the inspector, funnel start, rebase toggle, named cohorts,
   A/B compare; report exports; wide CSV and runs CSV inputs.
6. Spread visuals (B8b): whiskers, halo, numbers; then time-warp view and
   bake with preview (B8a), smear mode.
7. Live URL source; "aggregates only" storage mode.

Acceptance (per phase, manual + unit tests on `model/`):

- Round-trip: export milestones → synthetic telemetry generator script
  (`plugins/behavioral-analytics/tools/synth.ts`, generates N runs with
  configurable drop-off and timing noise) → import → funnel table matches
  the generator's parameters within tolerance.
- Disabling the plugin removes every badge, panel and menu entry and leaves
  the project JSON valid for the vanilla app; re-enabling restores datasets.
- Undo works across enable/disable, mapping edits, per-item settings,
  cohort changes and bakes.
- A 1 M-event CSV imports without freezing the UI.
- Synthetic generator with a known red/blue split and a known ALL-branch
  order distribution reproduces those shares in the branch inspector within
  1 pp; filtering to "Red" changes every downstream badge and the cohort bar
  count matches the generator.
- Bake preview's shift table equals the positions written by the bake; undo
  restores the exact previous positions.

### B12. Additional feature ideas (beyond the phases above)

Ranked roughly by value/effort; none are committed. (Cohorts, path/order
distributions, bake and spread visuals were promoted into B6a/B8a/B8b
during review.)

1. **Expected-vs-actual pacing** — target time per item plus a project-level
   "target run length"; the pacing lane shows cumulative drift.
2. **Where players quit** — histogram of last milestone reached; a "quit
   heat" tint on the item *after* the last reached one.
3. **Death heatmap** joined to *Death opportunity* items; deaths per
   attempt; "this death opportunity kills 3.2× more than designed".
4. **Attempt/retry counts** per milestone (from `attempt` events or repeated
   reaches after a death).
5. **Cohort comparison presets** — build vs build, platform vs platform,
   first-time vs returning players; delta badges.
6. **Statistical confidence** — Wilson intervals for reach rates, bootstrap
   CI for medians; badges fade when intervals are wide.
7. **Anomaly flags** — auto-detect milestones whose median moved > X % vs
   the compare dataset, or drop-offs above threshold; listed in "Top
   losses".
8. **Session/day boundaries** — if `ts` is present, show what fraction of
   runs cross a session break at each milestone (natural stopping points).
9. **Custom numeric events** (`kind=custom`, `value`) → per-item metric
   picker (e.g. damage taken, gold at milestone) with median/mean badges.
10. **Order-of-completion analysis for ALL branches** — Sankey-like mini
    diagram in the branch inspector.
11. **Skipped milestones** — for optional content, reach % is the metric;
    mark items as *optional* so they are excluded from step drop-off.
12. **Playtest notes overlay** — import moderator notes keyed by milestone
    id; shows as a second tooltip section (arguably a separate plugin).
13. **Auto-suggest section boundaries** where drop-off spikes.
14. **Time-scaled export** — export a "real-time" timeline JSON (positions =
    median seconds) for other tools.
15. **Live dashboard mode** — poll a URL every N minutes during a playtest;
    a small "live" pulse on the toolbar toggle; new runs animate in.
16. **Engine helper packages** — reference `MilestoneTracker` for Unity
    (C#), Unreal (C++/BP), Godot (GDScript) in `examples/engine/`.
17. **Synthetic data generator** in the UI (for demos and for trying the
    plugin on the template project before any real data exists).
18. **Per-player journeys** — pick one `player_id` and draw their run as a
    dotted trace along the timeline (time under each milestone).
19. **Retention view** — for multi-session games, reach % by calendar day
    since first play.
20. **Alerts export** — write the "Top losses" list as GitHub issues /
    Trello cards via a webhook (needs `network`).

### B13. Other plugin ideas the platform should be able to host

Sanity checks that the slot set is general enough:

- **Pacing curve** (tension/intensity value per item → lane chart).
- **Word count / read time** for description text per section.
- **Asset tracker** (custom fields → status badges, missing-asset tint).
- **Issue links** (Jira/GitHub/Trello ids in `link` → status badge via
  `network`).
- **Voice-over line budget** per section.
- **Timeline diff** (compare two project JSONs, tint added/removed/moved).
- **Presentation mode** (auto-scrolling camera along the spine, command +
  toolbar toggle).

---

## Part C — Decision log (confirmed 2026-09-08 / 2026-09-15)

Alternatives are listed a/b/c; the chosen one is marked **→**. Choices that
differ from the original recommendation are marked *(changed)*.

### C1. Platform

1. **Packaging & loading** (A3, A8)
   a. Bundled plugins only, toggled per project.
   b. External ES-module plugins only, everything loaded at runtime.
   **→ c.** Both: first-party plugins bundled; external plugins loaded from
   file/URL with the same API. External loading is platform phase 4.
2. **Where "installed" vs "enabled" lives** (A2, A6)
   a. Both per project.
   **→ b.** Installed app-wide (localStorage), enabled per project (project
   JSON). Bundled plugins are always installed.
   c. Both app-wide, with a per-project "disable" list.
3. **Plugin data placement** (A6, A7)
   a. Everything inside the project JSON (portable, but localStorage quota and
   huge exports).
   b. Everything in IndexedDB (nothing plugin-related in the JSON).
   **→ c.** Hybrid: small settings/data/mappings in the project JSON
   (undoable, shareable), bulky datasets in IndexedDB with a zip export.
4. **Schema versioning** (A6)
   **→ a.** Keep `schemaVersion: 1`, add optional `plugins` and `items[].key`.
   b. Bump to 2 with a migration step.
   c. Move plugin state to a sidecar file.
5. **Trust model for community plugins** (A9) *(changed)*
   **→ a.** Fully trusted, no prompts; permissions are descriptive metadata
   only.
   b. Trusted execution with a permissions dialog and a gated `network`.
   c. Sandboxed iframe with RPC (safer, more work, declarative UI only).
6. **Settings entry point** (A10)
   a. New "Plugins" section in the sidebar only.
   **→ b.** New Project Settings modal (gear in toolbar) with General /
   Plugins / Data tabs.
   c. Plugin toggles inside the template picker / new-project flow.
7. **Rendering model for contributions** (A5)
   **→ a.** React components + pure decoration functions, host renders.
   b. Declarative descriptors only (JSON-ish), no plugin React.
   c. Plugins own DOM/SVG nodes directly.

### C2. Analytics plugin

8. **Canonical export format** (B2)
   a. CSV only.
   b. JSON only.
   **→ c.** Both; CSV columns and a JSON manifest carrying structure.
9. **Join key** (B2, B3)
   a. `item.id` only.
   b. A new human-readable `key` only.
   **→ c.** Both: `id` is canonical, `key` optional; import matches id first,
   then key.
10. **Canonical telemetry input** (B4)
    **→ a.** Long-format events CSV (`run_id, milestone_id, t, …`) plus optional
    runs CSV; JSON bundle and wide CSV as conveniences.
    b. Wide CSV (one row per run).
    c. JSON only.
11. **Time semantics** (B3)
    **→ a.** Seconds since run start, gameplay time; wall clock optional in `ts`.
    b. Wall-clock timestamps only, run time derived.
    c. Frame or tick counts converted with a per-dataset rate.
12. **Reach-rate denominator** (B6, B6a) *(changed)*
    a. All runs, fixed.
    b. Runs that reached the first milestone, fixed.
    **→ d.** Owner's answer: make the denominator a **run cohort** the
    designer controls — pick any milestone as the funnel start, filter to
    the path chosen on an ANY branch, filter to the completion order on an
    ALL branch, and see the pick distribution when nothing is filtered.
    Specified in B6a; the default with no cohort is all runs.
13. **"Previous milestone" for drop-off** (B6)
    **→ a.** Timeline order by `pos` on the same line, with a per-item override.
    b. Explicit `prev` column in the milestones export, set by the designer.
    c. Data-driven: the milestone most runs reached immediately before.
14. **Raw data vs aggregates** (B5)
    **→ a.** Keep per-run arrays (any cohort combination), warn above 100 MB.
    b. Store only pre-aggregated sketches per dimension value.
    c. Require the engine tool to pre-aggregate.
15. **Multiple datasets per project** (B4, B8)
    a. Single dataset, re-import replaces.
    **→ b.** Named datasets, one active, one optional compare target.
    c. Datasets auto-split by `build` dimension.
16. **Primary visual** (B8)
    a. Badges only.
    b. Lane chart only.
    **→ c.** Badges + tint + optional lane, all toggleable; time-warp as a
    separate view.
17. **Time-warp view and bake** (B8a) *(changed)*
    a. Read-only view transform only.
    b. Bake to median only.
    **→ d.** Owner's answer: both, and the bake can target the **median or one
    specific run**, always behind a **preview** that shows how far each item
    moves; plus a visualisation of variation (see 25/26).
18. **Live data** (B7, B11)
    **→ a.** Phase 3 URL polling with headers.
    b. Not included; file import only.
    c. WebSocket stream.
19. **Engine helpers** (B3, B12)
    **→ a.** Contract + pseudo-code only in v1; engine packages later as
    examples.
    b. Ship a Unity C# package now.
    c. Ship Godot + Unity + Unreal now.
20. **Testing depth** (A12, B11)
    a. Manual only, matching DESIGN Q72.
    **→ b.** Vitest unit tests for parsers/aggregation/runtime reconcile;
    UI manual.
    c. Playwright end-to-end for the import flow too.

### C3. Run cohorts, bake and spread (added in review)

21. **Branch path detection** (B3, B6) *(changed)*
    a. Explicit path-entry milestones exported for the engine, with inference
    as fallback.
    **→ b.** Inference only: a run took a path if it reached any item on it;
    ALL-branch order comes from earliest reach times per path. Paths need
    at least one item to be measurable; the inspector warns otherwise.
    c. Explicit only.
22. **Where cohorts are built** (B6a)
    **→ a.** Item inspector + branch inspector + sidebar builder + Alt-click on
    canvas paths.
    b. Sidebar builder only.
    c. Inspector only.
23. **Time rebasing with a funnel start** (B6a)
    **→ a.** Toggle, default absolute (since run start).
    b. Always rebase.
    c. Never rebase.
24. **Comparison and saving** (B6a)
    **→ a.** Two cohorts active at once (A/B) with deltas; named cohorts saved
    in the project; dataset comparison uses the same mechanism.
    b. One cohort at a time, saved presets.
    c. One transient cohort.
25. **Spread visual** (B8b)
    **→ a.** Whisker (p25–p75 box, p10–p90 whiskers) under labelled nodes, halo
    on the ring at low zoom, smear band in time-warp, ±σ badge optional.
    b. Halo only.
    c. Smear in time-warp only.
26. **Spread statistic** (B8b)
    **→ a.** Percentiles drive the geometry; σ shown as a number.
    b. Standard deviation everywhere (±1σ/±2σ whiskers).
    c. Both, switchable.
27. **Seconds → timeline units for bake/time-warp** (B8a)
    **→ a.** Preserve total extent: first and last mapped milestones stay put.
    b. Fixed units per second setting.
    c. Anchor on the funnel start with a user factor.
