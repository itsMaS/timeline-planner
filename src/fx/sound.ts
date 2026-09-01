let ac: AudioContext | null = null
let enabled = false

export function setSoundOn(on: boolean) { enabled = on }

function ctx(): AudioContext | null {
  if (!enabled) return null
  try { ac ??= new AudioContext() } catch { return null }
  if (ac.state === 'suspended') ac.resume()
  return ac
}

function blip(freq: number, dur = 0.07, type: OscillatorType = 'sine', gain = 0.08) {
  const a = ctx()
  if (!a) return
  const o = a.createOscillator()
  const g = a.createGain()
  o.type = type
  o.frequency.value = freq
  g.gain.setValueAtTime(gain, a.currentTime)
  g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur)
  o.connect(g).connect(a.destination)
  o.start()
  o.stop(a.currentTime + dur)
}

export const sfx = {
  create: () => { blip(520, 0.08, 'triangle'); blip(780, 0.1, 'sine', 0.05) },
  delete: () => blip(180, 0.12, 'sawtooth', 0.05),
  snap: () => blip(900, 0.04, 'square', 0.04),
  select: () => blip(660, 0.04, 'sine', 0.04),
}
