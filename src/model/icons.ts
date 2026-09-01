import { icons } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export const ALL_ICON_NAMES = Object.keys(icons)

export function iconByName(name: string): LucideIcon {
  return (icons as Record<string, LucideIcon>)[name] ?? icons.Circle
}

const RAW_CATEGORIES: Record<string, string[]> = {
  Story: ['BookOpen', 'Book', 'Feather', 'MessageSquare', 'MessagesSquare', 'Quote', 'ScrollText', 'Drama', 'Clapperboard', 'Film', 'Mic', 'Speech', 'PenLine', 'NotebookPen', 'Newspaper', 'Theater'],
  Danger: ['Skull', 'Sword', 'Swords', 'Axe', 'Bomb', 'Crosshair', 'Target', 'Flame', 'Zap', 'ShieldAlert', 'TriangleAlert', 'AlertTriangle', 'HeartCrack', 'Biohazard', 'Radiation', 'CloudLightning', 'Siren'],
  People: ['User', 'Users', 'UserPlus', 'UserX', 'Baby', 'PersonStanding', 'Ghost', 'Bot', 'Cat', 'Dog', 'Bird', 'Rabbit', 'Squirrel', 'Fish', 'Bug', 'VenetianMask'],
  Objects: ['Key', 'KeyRound', 'Lock', 'Unlock', 'Gem', 'Crown', 'Coins', 'Gift', 'Backpack', 'Box', 'Package', 'Wrench', 'Hammer', 'FlaskConical', 'Scroll', 'Shield', 'Wand2', 'Lamp', 'BookLock', 'Pickaxe'],
  World: ['Map', 'MapPin', 'Compass', 'Globe', 'Mountain', 'MountainSnow', 'Trees', 'TreePine', 'Waves', 'Sun', 'Moon', 'CloudRain', 'Snowflake', 'Castle', 'Home', 'Building', 'Building2', 'DoorOpen', 'DoorClosed', 'Landmark', 'Tent', 'Anchor', 'Ship', 'Car', 'TrainFront'],
  Gameplay: ['Gamepad2', 'Joystick', 'Puzzle', 'Dices', 'Trophy', 'Medal', 'Star', 'Flag', 'FlagTriangleRight', 'Timer', 'Hourglass', 'Rocket', 'Footprints', 'Eye', 'EyeOff', 'Ear', 'Brain', 'Lightbulb', 'Sparkles', 'Swords', 'Heart', 'HeartPulse', 'Bed', 'Utensils'],
  Systems: ['Settings', 'Cog', 'SlidersHorizontal', 'Cpu', 'Database', 'Save', 'RefreshCw', 'Repeat', 'Shuffle', 'GitBranch', 'GitFork', 'GitMerge', 'Layers', 'Network', 'Workflow', 'CircuitBoard', 'Binary', 'TrendingUp', 'BarChart3', 'LineChart'],
  Markers: ['Bell', 'Bookmark', 'Calendar', 'Camera', 'Clock', 'Filter', 'Info', 'Link', 'List', 'Music', 'Pause', 'Play', 'Plus', 'Search', 'Tag', 'Video', 'Volume2', 'X', 'Check', 'CircleCheck', 'CircleAlert', 'Pin', 'StickyNote', 'Milestone', 'Signpost'],
}

/** Categories filtered to icons that actually exist in the bundled library. */
export const ICON_CATEGORIES: Record<string, string[]> = Object.fromEntries(
  Object.entries(RAW_CATEGORIES).map(([cat, names]) => [
    cat,
    [...new Set(names)].filter(n => n in icons),
  ]),
)

export function searchIcons(query: string, limit = 120): string[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const starts: string[] = []
  const contains: string[] = []
  for (const n of ALL_ICON_NAMES) {
    const ln = n.toLowerCase()
    if (ln.startsWith(q)) starts.push(n)
    else if (ln.includes(q)) contains.push(n)
    if (starts.length >= limit) break
  }
  return [...starts, ...contains].slice(0, limit)
}
