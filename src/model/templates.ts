import type { Item, Project } from './types'
import { blankProject } from './store'
import { uid } from './util'

function item(p: Project, typeName: string, pos: number, title: string, extra?: Partial<Item>): Item {
  const type = p.types.find(t => t.name === typeName) ?? p.types[0]
  return {
    id: uid(), typeId: type.id, layerId: null, pathId: null,
    pos, duration: 0, title, description: '', tags: [], link: '', images: [], fieldValues: {},
    ...extra,
  }
}

export function linearGameTemplate(): Project {
  const p = blankProject('Linear game')
  p.hierarchyLevels = ['Chapter', 'Level', 'Section']
  const [critical, major, minor, detail] = p.layers.map(l => l.id)
  p.types = [
    { id: uid(), name: 'Story beat', icon: 'BookOpen', color: '#3b82f6', defaultLayerId: critical, fields: [] },
    { id: uid(), name: 'Death opportunity', icon: 'Skull', color: '#ef4444', defaultLayerId: major, fields: [{ id: uid(), name: 'How the player dies' }] },
    { id: uid(), name: 'Encounter', icon: 'Swords', color: '#f97316', defaultLayerId: major, fields: [] },
    { id: uid(), name: 'Mechanic unlock', icon: 'Key', color: '#22c55e', defaultLayerId: major, fields: [] },
    { id: uid(), name: 'Cutscene', icon: 'Clapperboard', color: '#a855f7', defaultLayerId: minor, fields: [] },
    { id: uid(), name: 'Checkpoint', icon: 'Flag', color: '#14b8a6', defaultLayerId: detail, fields: [] },
    { id: uid(), name: 'Ambient detail', icon: 'Sparkles', color: '#eab308', defaultLayerId: detail, fields: [] },
  ]
  p.sections = [
    { id: uid(), name: 'Chapter 1 — The Descent', depth: 0, start: 0, end: 25 },
    { id: uid(), name: 'Chapter 2 — The City', depth: 0, start: 25, end: 50 },
    { id: uid(), name: 'Chapter 3 — The Truth', depth: 0, start: 50, end: 75 },
    { id: uid(), name: 'Chapter 4 — The Ascent', depth: 0, start: 75, end: 100 },
    { id: uid(), name: 'Tutorial cave', depth: 1, start: 0, end: 10 },
    { id: uid(), name: 'The chasm', depth: 1, start: 10, end: 25 },
    { id: uid(), name: 'Market district', depth: 1, start: 25, end: 38 },
    { id: uid(), name: 'Undercity', depth: 1, start: 38, end: 50 },
    { id: uid(), name: 'First steps', depth: 2, start: 0, end: 4 },
    { id: uid(), name: 'The drop', depth: 2, start: 4, end: 10 },
  ]
  p.items = [
    item(p, 'Story beat', 1, 'Opening — waking up'),
    item(p, 'Cutscene', 2, 'Intro cinematic'),
    item(p, 'Mechanic unlock', 3.5, 'Learn to move & jump'),
    item(p, 'Checkpoint', 4, 'CP: cave mouth'),
    item(p, 'Death opportunity', 5, 'Falling rocks', { duration: 4, fieldValues: {}, description: 'Player can be crushed while crossing the scree field.' }),
    item(p, 'Encounter', 7, 'First creature'),
    item(p, 'Story beat', 10, 'Meet the guide'),
    item(p, 'Mechanic unlock', 12, 'Grapple hook'),
    item(p, 'Death opportunity', 13, 'The chasm', { duration: 10, description: 'Any missed grapple over the chasm is fatal.' }),
    item(p, 'Checkpoint', 15, 'CP: ledge'),
    item(p, 'Ambient detail', 16, 'Distant city lights'),
    item(p, 'Encounter', 18, 'Nest ambush'),
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
  // ANY branch: two routes through the market
  const stealthPath = { id: uid(), label: 'Stealth route', terminal: false }
  const loudPath = { id: uid(), label: 'Loud route', terminal: false }
  p.branches.push({ id: uid(), mode: 'any', forkPos: 27, joinPos: 36, paths: [stealthPath, loudPath] })
  p.items.push(
    item(p, 'Encounter', 29, 'Rooftop patrols', { pathId: stealthPath.id }),
    item(p, 'Ambient detail', 32, 'Laundry lines', { pathId: stealthPath.id }),
    item(p, 'Encounter', 30, 'Front-door fight', { pathId: loudPath.id }),
    item(p, 'Death opportunity', 33, 'Overwhelmed by guards', { pathId: loudPath.id }),
  )
  // ALL branch: three trials in any order
  const t1 = { id: uid(), label: 'Trial of Echoes', terminal: false }
  const t2 = { id: uid(), label: 'Trial of Ash', terminal: false }
  const t3 = { id: uid(), label: 'Trial of Glass', terminal: false }
  p.branches.push({ id: uid(), mode: 'all', forkPos: 53, joinPos: 61, paths: [t1, t2, t3] })
  p.items.push(
    item(p, 'Encounter', 55, 'Echo maze', { pathId: t1.id }),
    item(p, 'Encounter', 56, 'Ash golem', { pathId: t2.id }),
    item(p, 'Death opportunity', 57, 'Glass bridge', { pathId: t3.id, description: 'Shattering floor tiles.' }),
  )
  const storyType = p.types[0]
  p.views = [
    { id: uid(), name: 'Story beats', filters: { offTypes: p.types.filter(t => t.id !== storyType.id && t.name !== 'Cutscene').map(t => t.id), offLayers: [], tags: [], text: '' } },
    { id: uid(), name: 'Deaths', filters: { offTypes: p.types.filter(t => t.name !== 'Death opportunity').map(t => t.id), offLayers: [], tags: [], text: '' } },
  ]
  return p
}

export function filmTemplate(): Project {
  const p = blankProject('Film script')
  p.hierarchyLevels = ['Act', 'Sequence', 'Scene']
  const [critical, major, minor] = p.layers.map(l => l.id)
  p.types = [
    { id: uid(), name: 'Plot point', icon: 'Star', color: '#f59e0b', defaultLayerId: critical, fields: [] },
    { id: uid(), name: 'Scene', icon: 'Clapperboard', color: '#3b82f6', defaultLayerId: major, fields: [] },
    { id: uid(), name: 'Character intro', icon: 'UserPlus', color: '#22c55e', defaultLayerId: major, fields: [] },
    { id: uid(), name: 'Setpiece', icon: 'Flame', color: '#ef4444', defaultLayerId: minor, fields: [] },
  ]
  p.sections = [
    { id: uid(), name: 'Act I', depth: 0, start: 0, end: 25 },
    { id: uid(), name: 'Act II', depth: 0, start: 25, end: 75 },
    { id: uid(), name: 'Act III', depth: 0, start: 75, end: 100 },
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
  p.hierarchyLevels = ['Phase', 'Milestone', 'Sprint']
  const [critical, major, minor] = p.layers.map(l => l.id)
  p.types = [
    { id: uid(), name: 'Milestone', icon: 'Milestone', color: '#3b82f6', defaultLayerId: critical, fields: [] },
    { id: uid(), name: 'Task', icon: 'CircleCheck', color: '#22c55e', defaultLayerId: major, fields: [] },
    { id: uid(), name: 'Risk', icon: 'TriangleAlert', color: '#ef4444', defaultLayerId: major, fields: [] },
    { id: uid(), name: 'Decision', icon: 'GitFork', color: '#a855f7', defaultLayerId: minor, fields: [] },
  ]
  p.sections = [
    { id: uid(), name: 'Discovery', depth: 0, start: 0, end: 20 },
    { id: uid(), name: 'Build', depth: 0, start: 20, end: 70 },
    { id: uid(), name: 'Launch', depth: 0, start: 70, end: 100 },
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
  { key: 'game', name: 'Linear game', blurb: 'Chapters, story beats, death opportunities, branches — a seeded 4-hour game plan.', make: linearGameTemplate },
  { key: 'film', name: 'Film script', blurb: 'Acts, sequences and scenes with classic plot-point types.', make: filmTemplate },
  { key: 'plan', name: 'Project plan', blurb: 'Phases, milestones, tasks and risks over time.', make: projectPlanTemplate },
]
