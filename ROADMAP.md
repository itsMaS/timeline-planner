# Roadmap

What the fields system is meant to become, what has shipped, and the
decisions behind it. The guiding rule for everything here: **the everyday
experience stays as simple as it is today, and the power sits one click
deeper** (a checkbox in an editor, a funnel next to the search box, a folder
you only make when you have too many fields). Nothing on this page adds a
required step to placing an item on the line.

Decisions were taken with the owner in a series of clickable rounds; the
"Decisions" sections record them so later work does not relitigate them.

## Shipped

### Fields on the canvas

- **Toggle badges.** A toggle field can be shown as a ✓ (green) / ✗ (muted)
  badge on the item's icon corner instead of in the label; several badges
  shrink and stack. Sections show a ✓ after the band name for their own
  toggles. Off by default, switched on per field (*Show as badge* in the field
  editor). Hidden fields do not badge.
- **Visibility.** Every field and processor has an eye in the sidebar. A
  hidden field disappears from labels, tooltips, badges and exports but stays
  in the inspector; a hidden processor leaves the band badge and exports. The
  set of hidden ids lives in the per-user filters (`offFields`,
  `offProcessors`) and is saved with views, so a view can be "just the VFX
  columns".
- **Reveal.** The target icon next to a field turns on every type that
  attaches it, in the live filters.

### Rule filters and the expression language

- One small language (`src/model/expr.ts`) is shared by the funnel filter,
  processor conditions, derived formulas, the API and the CLI. It reads like
  a sentence: `Implemented = no and [VFX Scope] >= 10`,
  `Stage one of (Blocked, Review) or tags has boss`.
- The funnel button next to the search box opens a popover with **rule rows**
  (field, operator, value) and a **text mode** for the same expression; rows
  and text convert both ways. Rules are AND-ed on top of the type, layer, tag
  and text filters and hidden items hide (never dim). Rules only apply to
  items; sections are never filtered.
- Rules are stored in `filters.rules` and saved with views.

### Processors

- **Conditions.** A processor can carry a `where` rule; only entries inside
  the section that satisfy it count. "Remaining VFX scope" is
  `sum(VFX Scope) where Implemented = no`.
- **Exports.** Processor results appear under each section heading in the
  document PDF and in a second "sections" table in the CSV.

### Organisation

- **Folders** for fields and for processors, with the same model as type
  folders (colour, icon, nesting, collapse) and drag-and-drop reordering and
  filing in the sidebar. Folders group fields in the inspector and in exports;
  processors have their own tree.
- **Sidebar search boxes** filter their list in place (types, fields,
  processors), auto-expanding folders that contain a match. Item creation
  stays on the canvas (right-click, Space, drag from the list). A *New type*
  row at the bottom of the list opens the editor.

### Composite and derived fields

- **Composites** are fields of kind `group` that own other fields (`children`
  / `parentId`). A group is attached to a type or level as one unit, may set
  per-child defaults on the attachment, renders as a boxed group in the
  inspector and as one label on the canvas through a display template
  (`{Done} / {Total}`; children joined with " · " when empty). Children keep
  their own values and can be moved in and out of a group in the editor.
- **Derived fields** carry a `formula` and are computed on read, never
  stored. A formula sees every field on the entity (siblings inside its
  composite first) and the built-ins, and the result is coerced to the
  field's declared kind, so a derived int is still an int in filters,
  processors and exports.

### Inspector

- Number fields no longer lose an edit when another entry is selected
  (selection happened on pointer down before the input blurred); inputs flush
  on unmount and are keyed by their owner.
- Enter commits and moves to the next input; Shift+Enter goes back. This
  applies to every inspector input, not only fields.
- Toggle defaults are two *Yes* / *No* buttons with neither lit when unset,
  so a default no longer looks like a set value. Reset is a ↺ icon.

### API and agent CLI (full parity)

- `api_schema` returns field and processor folders; `api_set_field` and
  `api_create_item` understand composites (a child is attached through its
  group) and refuse derived fields.
- `api_create_field` and `api_update_field` let a tool create fields and
  change their settings. Kind, children, parent and folder stay under the
  app's control, as do types, levels, layers and timelines.
- `api-query` (Edge Function) evaluates a rule against every item and, with
  `p_compute`, returns derived values and processor results, which the stored
  document never contains.
- The agent CLI gained `query --where` (`--compute`, `--json`, `--timeline`)
  and `export --where`; `outline` shows folders, composites, formulas and
  processor conditions. Plugin 1.4.0.
- Viewers get the same views and can filter locally, including rules and
  visibility, without touching the shared document.

## Decisions

- Toggle badges sit on the icon corner, ✓ green and ✗ muted, shrink and stack
  when there are several; also in section band labels. Off by default per
  field.
- A hidden field is hidden everywhere except the inspector. Visibility is part
  of the filters, so it saves with views and viewers can use it.
- Reveal means "show the types that attach this field".
- Rule filters offer rows and a text mode; they AND on top of the other
  filters; hidden items hide rather than dim; operators are `= != < <= > >=`,
  `is set` / `is empty`, `contains` / `one of`, `has` / `count` on references;
  items only.
- Processor conditions reuse the rule language. Processor math (sum of a
  formula) is done through derived fields rather than a second expression
  slot on the processor.
- PDF: processors under the section heading. CSV: a second sections table.
- The condition drives everything a processor reports (inspector, band badge,
  exports).
- Toggle defaults are two buttons with none lit; reset is a ↺ icon.
- Numeric fix: flush on selection change and key inputs by owner. Enter moves
  to the next input across every inspector input.
- Field and processor folders use the type folder model, group in the
  inspector and exports, reorder by drag and drop; processors have their own
  tree.
- Type search filters in place with folders auto-expanded; item creation stays
  on the canvas; one search box per sidebar section; a *New type* row opens
  the editor.
- Composites are a `group` kind with owned children, a display template and
  per-child defaults on the attachment; shown as a boxed group with a
  template preview in the inspector.
- Derived fields read any field on the entity (siblings first), spreadsheet
  syntax, computed on read, usable in filters and processors, with a declared
  kind.
- Names in expressions are bare, with `[brackets]` when needed.
- Progressive disclosure per editor: the simple form first, advanced sections
  (folder, composite, formula, badge) below.
- API and CLI keep full parity with the app every release. The API may create
  fields and change their settings (`api_create_field`, `api_update_field`);
  it still cannot delete, move, or change types, levels, layers or timelines.
- Migration is additive: every new document key is optional and filled in by
  `normalizeProject`; `schemaVersion` stays 1.
- Everything above shipped in one run as separate commits, one push after a
  full build.

## Next

Ordered roughly by how often the need has come up.

1. **Processor arithmetic on the band.** A processor that combines two
   others (`remaining / total * 100`). Today this needs a derived field per
   item plus a sum; a derived *section* value over processor results would
   make percentages a one-liner. Reuses the expression language with
   processor names in scope.
2. **Rule rows for sections.** Rules only filter items. A section rule
   (`level = Level and length > 20`) would let a view hide whole bands.
3. **Per-attachment badge and visibility.** Badge and hidden state are per
   field; a type-level override ("badge Implemented on VFX items only") would
   avoid duplicate fields.
4. **Column picker in CSV export.** Choose and order columns from the export
   dialog instead of relying on hidden fields.
5. **Expression autocomplete.** The text mode of the funnel and the formula
   editor list names on request; inline completion and error underlines
   would make the language easier to discover.
6. **Composite templates with formatting.** `{Done}/{Total} ({Left} left)`
   works; number formatting (`{Cost:0.0}`) and conditional parts do not.
7. **API: folders and attachments.** `api_create_field` can attach on
   creation and file into a folder, but there is no call to move an existing
   field, create a folder, or attach a field to another type. Grow this with
   new `api_*` functions rather than widening `api_update_field`.
8. **Bulk edit.** Select several items and set a field once; the rule filter
   makes selecting the right ones easy, the inspector does not yet act on a
   multi-selection.

## Open questions

- Should a derived field's formula error (bad name, division by zero) show on
  the canvas, or only in the inspector and the field editor as today?
- Composite children currently cannot be attached on their own. Is there a
  case for a child that is both part of a group and a standalone field on
  another type?
- Rule filters hide items; a "dim instead of hide" toggle exists for the other
  filters. Is one setting for both enough?
- The Edge Function evaluates on a full document read. Large projects
  (thousands of items with images) may want a leaner `api_read` variant
  without images first.
