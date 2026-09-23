export type Id = string

/** `group` is a composite: it holds other fields (`children`) and has no value of its own. */
export type FieldKind = 'text' | 'int' | 'float' | 'toggle' | 'select' | 'ref' | 'group'

/** Stored value: text → string, int/float → number, toggle → boolean, select → chosen options, ref → target ids. */
export type FieldValue = string | number | boolean | Id[]

/** A project-wide field definition. Types and hierarchy levels attach these. */
export interface FieldDef {
  id: Id
  name: string
  kind: FieldKind
  /** Short hint shown under the input. */
  help: string
  /** Warn (red outline) when the owner leaves it empty. */
  required: boolean
  /** Show the value in the canvas hover tooltip. */
  showInTooltip: boolean
  /**
   * Show the field's name next to its value (canvas labels, tooltip,
   * inspector, exports). Off when the value speaks for itself, e.g. a number
   * with a unit — the name then only identifies the field in the schema.
   */
  showName: boolean
  /** Global fallback default; an attachment may override it. null = none. */
  defaultValue: FieldValue | null
  /** text: hard character limit; null = unlimited. */
  maxLength: number | null
  /** int / float bounds; null = unbounded. */
  min: number | null
  max: number | null
  /** float: digits after the decimal point; null = free. */
  decimals: number | null
  /** int / float: suffix shown after the value (e.g. "coins"). */
  unit: string
  /** select: the preset choices, in display order. */
  options: string[]
  /** select: several choices instead of one. */
  selectMultiple: boolean
  /** ref: allowed item type ids and hierarchy level ids; empty = anything. */
  refTargets: Id[]
  /** ref: several targets instead of one. */
  refMultiple: boolean
  /** ref: draw connector lines on the canvas while the owner is selected. */
  refShowLinks: boolean
  /** Sidebar folder (Project.fieldFolders); null/undefined = root. Groups the field in the inspector and exports too. */
  folderId?: Id | null
  /**
   * toggle: draw a ✓ / ✗ badge on the item's icon (and a ✓ after a section's
   * name) so the state reads at a glance. Off by default.
   */
  badge?: boolean
  /**
   * group: the fields inside, in display order. Children are ordinary
   * project fields owned by exactly one group (`parentId`); attaching the
   * group attaches them all, and their values stay flat in `fieldValues`.
   */
  children?: Id[]
  /**
   * group: how the composite reads as one value, e.g. `{done}/{total}`
   * (child names in braces). Empty = the children are shown one by one.
   */
  template?: string
  /** The group this field belongs to; null/undefined = a top-level field. */
  parentId?: Id | null
  /**
   * Derived field: an expression (src/model/expr.ts) computed on read from
   * the entity's other fields, e.g. `total - done`; the result is coerced to
   * the field's kind. Empty = a normal, stored field.
   */
  formula?: string
}

/** A field attached to a type or a hierarchy level. */
export interface FieldAttachment {
  fieldId: Id
  /** Overrides the field's own default for this type/level; null = inherit. */
  defaultValue: FieldValue | null
  /** group attachments: per-child default overrides keyed by child field id. */
  childDefaults?: Record<Id, FieldValue | null>
}

export type ProcessorOp = 'sum' | 'count' | 'avg' | 'min' | 'max' | 'distinct'

/** A project-wide aggregation over the items (and child sections) inside a section. */
export interface ProcessorDef {
  id: Id
  name: string
  op: ProcessorOp
  /** Field aggregated; null for count. */
  fieldId: Id | null
  /** Item type ids / hierarchy level ids to include; empty = everything. */
  targets: Id[]
  /**
   * Rule expression (src/model/expr.ts) an entity must satisfy to be counted,
   * e.g. `Implemented = no` for a "Remaining VFX scope" sum. Empty = no rule.
   */
  where?: string
  /** Sidebar folder (Project.processorFolders); null/undefined = root. */
  folderId?: Id | null
}

export interface ProcessorAttachment {
  processorId: Id
  /** Append the result to the section's band label on the canvas. */
  showOnBand: boolean
}

/** One level of the section hierarchy (Chapter, Level, …); Section.depth indexes into these. */
export interface HierarchyLevel {
  id: Id
  name: string
  fields: FieldAttachment[]
  processors: ProcessorAttachment[]
}

export interface ItemType {
  id: Id
  name: string
  icon: string
  color: string
  defaultLayerId: Id | null
  fields: FieldAttachment[]
  /** Folder this type is filed under in the sidebar; null/undefined = root. */
  folderId?: Id | null
}

/**
 * A loose sidebar folder. The same shape organizes item types
 * (`Project.typeFolders`), fields (`fieldFolders`) and processors
 * (`processorFolders`); folders nest via parentId, members point at their
 * folder through their own `folderId`.
 */
export interface Folder {
  id: Id
  name: string
  color: string
  icon: string
  collapsed: boolean
  /** Parent folder; null/undefined = top level. */
  parentId?: Id | null
  /**
   * Type folders only: fields every type filed in this folder (at any depth)
   * inherits on top of its own attachments; a nearer attachment (sub-folder
   * or the type itself) overrides the default. See `typeAttachments` in fields.ts.
   */
  fields?: FieldAttachment[]
}

export type TypeFolder = Folder

/** Which folder list a folder or member belongs to. */
export type FolderKind = 'types' | 'fields' | 'processors'

/** Order in Project.layers = significance (index 0 is most significant). */
export interface Layer {
  id: Id
  name: string
  /** Always hidden regardless of zoom/density. */
  eye: boolean
  /** Always shown regardless of zoom/density. */
  pin: boolean
  /** Visual scale multiplier for items in this layer (1 = normal). */
  size: number
  /**
   * Zoom threshold (camera px per world unit): when the camera is zoomed out
   * below this, items in this layer collapse to small dots on the line.
   * 0 = never minimize.
   */
  minZoom: number
}

export interface Section {
  id: Id
  name: string
  /** The timeline (subtab) this section lives on; see Project.timelines. */
  timelineId: Id
  /** Index into Project.hierarchyLevels. */
  depth: number
  start: number
  end: number
  /** Markdown notes, like an item's description. Normalized to '' on load. */
  description?: string
  /** Values of the fields attached to the section's hierarchy level. */
  fieldValues: Record<Id, FieldValue>
}

export interface Item {
  id: Id
  typeId: Id
  /** The timeline (subtab) this item lives on; see Project.timelines. */
  timelineId: Id
  /** null = use the type's default layer. */
  layerId: Id | null
  pos: number
  duration: number
  title: string
  description: string
  tags: string[]
  link: string
  images: string[]
  fieldValues: Record<Id, FieldValue>
  /**
   * Collaborator who created the item: a snapshot of their display name and
   * colour (the identity shown to others in the Share dialog) taken when the
   * item was made. Absent on items from before this was recorded.
   */
  createdBy?: { name: string; color: string }
}

export interface Filters {
  /** Type ids currently toggled OFF. */
  offTypes: Id[]
  /** Layer ids currently toggled OFF via filtering (distinct from layer.eye). */
  offLayers: Id[]
  /** Tags that must be present (OR within, AND with other groups). */
  tags: string[]
  text: string
  /**
   * Rule expression (src/model/expr.ts) every shown item must satisfy, e.g.
   * `Implemented = no and [VFX Scope] >= 10`. Empty = no rule. ANDed with the
   * other filter groups. Saved in views like the rest.
   */
  rules: string
  /** Field ids hidden from the canvas labels, tooltip and exports (the inspector always shows them). */
  offFields: Id[]
  /** Processor ids hidden from the band badge and exports (the inspector always shows them). */
  offProcessors: Id[]
}

export interface View {
  id: Id
  name: string
  filters: Filters
}

export interface Camera {
  /** World coordinate at the left edge of the viewport. */
  x: number
  /** Pixels per world unit. */
  s: number
}

export type UnitPreset = 'none' | 'minutes' | 'hours' | 'days' | 'weeks' | 'months' | 'years' | 'custom'

export interface TimelineSettings {
  /** Where markers may be placed relative to the spine. */
  placement: 'above' | 'both'
  unit: {
    preset: UnitPreset
    /** Suffix used when preset is 'custom' (e.g. "beats"). */
    custom: string
    /** Draw tick marks + unit labels along the spine. */
    showRuler: boolean
  }
  grid: {
    show: boolean
    style: 'solid' | 'dashed' | 'dots'
    /** 0..1 */
    opacity: number
  }
  spine: {
    /** Stroke width in px. */
    width: number
    /** 0..1 */
    opacity: number
  }
  /** Multiplier for section band tint (0 = invisible, 1 = default, 2 = strong). */
  bandStrength: number
  sectionStyle: {
    /** Label font size (px) for top-level sections; deeper levels shrink. */
    labelSize: number
    /** Border opacity for top-level sections; fades with depth. */
    edgeStrength: number
    /** Show the section's duration in faint text after its name. */
    showDuration: boolean
  }
}

/**
 * One timeline (a subtab of the project): its own sections and items on a
 * shared schema. Items and sections point at it through `timelineId`; the
 * project always has at least one. Settings are per timeline, so one can run
 * in minutes while another counts beats; fields, types, folders, layers,
 * hierarchy levels, processors and views are shared by the whole project.
 */
export interface Timeline {
  id: Id
  name: string
  settings: TimelineSettings
}

export interface Project {
  schemaVersion: 1
  id: Id
  name: string
  hierarchyLevels: HierarchyLevel[]
  fields: FieldDef[]
  processors: ProcessorDef[]
  types: ItemType[]
  typeFolders: Folder[]
  fieldFolders: Folder[]
  processorFolders: Folder[]
  layers: Layer[]
  /** Timelines (subtabs), in tab order; never empty after normalization. */
  timelines: Timeline[]
  sections: Section[]
  items: Item[]
  views: View[]
  /** Camera of the active timeline (per user, never synced). */
  camera: Camera
  /** Cameras of the other timelines, keyed by timeline id (per user, never synced). */
  cameras: Record<Id, Camera>
  filters: Filters
  activeViewId: Id | null
  /** Which timeline this tab shows (per user, never synced); null resolves to the first. */
  activeTimelineId: Id | null
  /**
   * Project-level settings from before timelines had their own: kept as the
   * migration source and the default for new timelines. What the canvas uses
   * is the active timeline's `settings` (see `timelineView`).
   */
  settings: TimelineSettings
}
