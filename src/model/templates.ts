import { newFieldDef } from './fields'
import { blankProject, emptyFilters, newLevel } from './store'
import type { Item, Project, Section } from './types'
import { uid } from './util'

function item(p: Project, typeName: string, pos: number, title: string, extra?: Partial<Item>): Item {
  const type = p.types.find(t => t.name === typeName) ?? p.types[0]
  return {
    id: uid(), typeId: type.id, timelineId: p.timelines[0].id, layerId: null,
    pos, duration: 0, title, description: '', tags: [], link: '', images: [], fieldValues: {},
    ...extra,
  }
}

function section(p: Project, name: string, depth: number, start: number, end: number): Section {
  return { id: uid(), name, timelineId: p.timelines[0].id, depth, start, end, fieldValues: {} }
}

export function linearGameTemplate(): Project {
  const p = blankProject('Linear game')
  p.hierarchyLevels = ['Chapter', 'Level', 'Section'].map(n => newLevel(n))
  const [critical, major, minor, detail] = p.layers.map(l => l.id)
  // Global fields + processors: a small demo of the coin-counting workflow.
  const howDies = newFieldDef(uid(), 'How the player dies', 'text')
  const coins = { ...newFieldDef(uid(), 'Coins', 'int'), min: 0, unit: 'coins', showInTooltip: true, help: 'Currency the player can earn here.' }
  p.fields = [howDies, coins]
  p.types = [
    { id: uid(), name: 'Story beat', icon: 'BookOpen', color: '#3b82f6', defaultLayerId: critical, fields: [] },
    { id: uid(), name: 'Death opportunity', icon: 'Skull', color: '#ef4444', defaultLayerId: major, fields: [{ fieldId: howDies.id, defaultValue: null }] },
    { id: uid(), name: 'Encounter', icon: 'Swords', color: '#f97316', defaultLayerId: major, fields: [{ fieldId: coins.id, defaultValue: 3 }] },
    { id: uid(), name: 'Mechanic unlock', icon: 'Key', color: '#22c55e', defaultLayerId: major, fields: [] },
    { id: uid(), name: 'Cutscene', icon: 'Clapperboard', color: '#a855f7', defaultLayerId: minor, fields: [] },
    { id: uid(), name: 'Checkpoint', icon: 'Flag', color: '#14b8a6', defaultLayerId: detail, fields: [] },
    { id: uid(), name: 'Ambient detail', icon: 'Sparkles', color: '#eab308', defaultLayerId: detail, fields: [] },
  ]
  const encounter = p.types.find(t => t.name === 'Encounter')!
  const coinTotal = { id: uid(), name: 'Coin total', op: 'sum' as const, fieldId: coins.id, targets: [] }
  const enemies = { id: uid(), name: 'Enemies', op: 'count' as const, fieldId: null, targets: [encounter.id] }
  p.processors = [coinTotal, enemies]
  p.hierarchyLevels[0].processors = [
    { processorId: coinTotal.id, showOnBand: true },
    { processorId: enemies.id, showOnBand: true },
  ]
  p.sections = [
    section(p, 'Chapter 1 — The Descent', 0, 0, 25),
    section(p, 'Chapter 2 — The City', 0, 25, 50),
    section(p, 'Chapter 3 — The Truth', 0, 50, 75),
    section(p, 'Chapter 4 — The Ascent', 0, 75, 100),
    section(p, 'Tutorial cave', 1, 0, 10),
    section(p, 'The chasm', 1, 10, 25),
    section(p, 'Market district', 1, 25, 38),
    section(p, 'Undercity', 1, 38, 50),
    section(p, 'First steps', 2, 0, 4),
    section(p, 'The drop', 2, 4, 10),
  ]
  p.items = [
    item(p, 'Story beat', 1, 'Opening — waking up'),
    item(p, 'Cutscene', 2, 'Intro cinematic'),
    item(p, 'Mechanic unlock', 3.5, 'Learn to move & jump'),
    item(p, 'Checkpoint', 4, 'CP: cave mouth'),
    item(p, 'Death opportunity', 5, 'Falling rocks', { duration: 4, fieldValues: { [howDies.id]: 'Crushed by rockfall' }, description: 'Player can be crushed while crossing the scree field.' }),
    item(p, 'Encounter', 7, 'First creature', { fieldValues: { [coins.id]: 1 } }),
    item(p, 'Story beat', 10, 'Meet the guide'),
    item(p, 'Mechanic unlock', 12, 'Grapple hook'),
    item(p, 'Death opportunity', 13, 'The chasm', { duration: 10, description: 'Any missed grapple over the chasm is fatal.' }),
    item(p, 'Checkpoint', 15, 'CP: ledge'),
    item(p, 'Ambient detail', 16, 'Distant city lights'),
    item(p, 'Encounter', 18, 'Nest ambush', { fieldValues: { [coins.id]: 8 } }),
    item(p, 'Story beat', 24, 'First sight of the city'),
    item(p, 'Story beat', 25.5, 'Arrival at the gates'),
    item(p, 'Cutscene', 26, 'Gate confrontation'),
    item(p, 'Encounter', 30, 'Market brawl'),
    item(p, 'Death opportunity', 33, 'Rooftop chase', { duration: 4, description: 'Missed jumps during the chase.' }),
    item(p, 'Checkpoint', 37, 'CP: safehouse'),
    item(p, 'Story beat', 40, 'The betrayal'),
    item(p, 'Mechanic unlock', 43, 'Disguise system'),
    item(p, 'Story beat', 49, 'Descent into the undercity'),
    item(p, 'Story beat', 52, 'The archive'),
    item(p, 'Encounter', 58, 'Archive guardians'),
    item(p, 'Story beat', 62, 'Revelation'),
    item(p, 'Cutscene', 63, 'Flashback sequence'),
    item(p, 'Death opportunity', 68, 'The collapsing vault', { duration: 6, description: 'Timed escape; running out of time is fatal.' }),
    item(p, 'Story beat', 76, 'The climb begins'),
    item(p, 'Encounter', 82, 'Final guardian'),
    item(p, 'Story beat', 90, 'The choice'),
    item(p, 'Cutscene', 96, 'Ending cinematic'),
    item(p, 'Story beat', 99, 'Credits & stinger'),
  ]
  p.items.push(
    item(p, 'Encounter', 29, 'Rooftop patrols'),
    item(p, 'Encounter', 31, 'Front-door fight'),
    item(p, 'Ambient detail', 33, 'Laundry lines'),
    item(p, 'Death opportunity', 35, 'Overwhelmed by guards'),
    item(p, 'Encounter', 54, 'Echo maze'),
    item(p, 'Encounter', 56, 'Ash golem'),
    item(p, 'Death opportunity', 58, 'Glass bridge', { description: 'Shattering floor tiles.' }),
  )
  const storyType = p.types[0]
  p.views = [
    { id: uid(), name: 'Story beats', filters: { ...emptyFilters(), offTypes: p.types.filter(t => t.id !== storyType.id && t.name !== 'Cutscene').map(t => t.id) } },
    { id: uid(), name: 'Deaths', filters: { ...emptyFilters(), offTypes: p.types.filter(t => t.name !== 'Death opportunity').map(t => t.id) } },
  ]
  return p
}

export function filmTemplate(): Project {
  const p = blankProject('Film script')
  p.hierarchyLevels = ['Act', 'Sequence', 'Scene'].map(n => newLevel(n))
  const [critical, major, minor] = p.layers.map(l => l.id)
  p.types = [
    { id: uid(), name: 'Plot point', icon: 'Star', color: '#f59e0b', defaultLayerId: critical, fields: [] },
    { id: uid(), name: 'Scene', icon: 'Clapperboard', color: '#3b82f6', defaultLayerId: major, fields: [] },
    { id: uid(), name: 'Character intro', icon: 'UserPlus', color: '#22c55e', defaultLayerId: major, fields: [] },
    { id: uid(), name: 'Setpiece', icon: 'Flame', color: '#ef4444', defaultLayerId: minor, fields: [] },
  ]
  p.sections = [
    section(p, 'Act I', 0, 0, 25),
    section(p, 'Act II', 0, 25, 75),
    section(p, 'Act III', 0, 75, 100),
  ]
  p.items = [
    item(p, 'Plot point', 3, 'Opening image'),
    item(p, 'Character intro', 6, 'Protagonist'),
    item(p, 'Plot point', 12, 'Inciting incident'),
    item(p, 'Plot point', 25, 'Break into Act II'),
    item(p, 'Setpiece', 40, 'Midpoint chase'),
    item(p, 'Plot point', 50, 'Midpoint reversal'),
    item(p, 'Plot point', 75, 'Break into Act III'),
    item(p, 'Setpiece', 88, 'Climax'),
    item(p, 'Plot point', 97, 'Final image'),
  ]
  return p
}

export function projectPlanTemplate(): Project {
  const p = blankProject('Project plan')
  p.hierarchyLevels = ['Phase', 'Milestone', 'Sprint'].map(n => newLevel(n))
  const [critical, major, minor] = p.layers.map(l => l.id)
  p.types = [
    { id: uid(), name: 'Milestone', icon: 'Milestone', color: '#3b82f6', defaultLayerId: critical, fields: [] },
    { id: uid(), name: 'Task', icon: 'CircleCheck', color: '#22c55e', defaultLayerId: major, fields: [] },
    { id: uid(), name: 'Risk', icon: 'TriangleAlert', color: '#ef4444', defaultLayerId: major, fields: [] },
    { id: uid(), name: 'Decision', icon: 'GitFork', color: '#a855f7', defaultLayerId: minor, fields: [] },
  ]
  p.sections = [
    section(p, 'Discovery', 0, 0, 20),
    section(p, 'Build', 0, 20, 70),
    section(p, 'Launch', 0, 70, 100),
  ]
  p.items = [
    item(p, 'Milestone', 20, 'Spec approved'),
    item(p, 'Task', 30, 'Core prototype', { duration: 15 }),
    item(p, 'Risk', 45, 'Vendor dependency', { duration: 20 }),
    item(p, 'Milestone', 70, 'Feature complete'),
    item(p, 'Decision', 80, 'Go / no-go'),
    item(p, 'Milestone', 95, 'Ship'),
  ]
  return p
}

export const TEMPLATES: { key: string; name: string; blurb: string; make: () => Project }[] = [
  { key: 'empty', name: 'Empty', blurb: 'A blank line and one starter type. Bring your own structure.', make: () => blankProject('Untitled') },
  { key: 'game', name: 'Linear game', blurb: 'Chapters, story beats, encounters, death opportunities — a seeded 4-hour game plan.', make: linearGameTemplate },
  { key: 'film', name: 'Film script', blurb: 'Acts, sequences and scenes with classic plot-point types.', make: filmTemplate },
  { key: 'plan', name: 'Project plan', blurb: 'Phases, milestones, tasks and risks over time.', make: projectPlanTemplate },
]
