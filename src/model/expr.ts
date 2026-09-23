/**
 * The small expression language shared by rule filters ("show items where
 * …"), processor conditions ("sum X where …") and derived fields ("total -
 * done"). One tokenizer, one parser, one evaluator; the surface is meant to
 * read like a sentence:
 *
 *   Implemented = no and [VFX Scope] >= 10
 *   Stage one of (Blocked, Review) or tags has boss
 *   done / total * 100
 *   if(Implemented, 0, [VFX Scope])
 *
 * Names: a bare word refers to a field of the entity (case-insensitive) or a
 * built-in (title, type, tags, layer, pos, duration, description, link,
 * section; for sections name, level, start, end, length). Names with spaces
 * or symbols go in [brackets]. A bare word that names nothing is taken as
 * text, so `Status = blocked` works without quotes. Strings may also be
 * quoted with " or '.
 *
 * Operators, loosest first: or / ||, and / &&, not / !, comparisons
 * (= == != <> < <= > >=, contains, has, one of / in, is set / is empty /
 * is not set), + -, * / %, unary -. Lists are parenthesised comma lists.
 * Functions: if, min, max, abs, round, floor, ceil, len, sum, avg, coalesce,
 * lower, upper, contains, empty.
 *
 * Values are numbers, strings, booleans, lists of strings (dropdowns,
 * references, tags) or null (unset). Arithmetic treats null as 0; comparisons
 * against null are false except = / != and is set / is empty.
 */

export type Value = number | string | boolean | string[] | null

export type Ast =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'null' }
  | { t: 'name'; name: string; bracketed: boolean }
  | { t: 'list'; items: Ast[] }
  | { t: 'un'; op: '-' | 'not'; a: Ast }
  | { t: 'bin'; op: BinOp; a: Ast; b: Ast }
  | { t: 'isset'; a: Ast; set: boolean }
  | { t: 'call'; fn: string; args: Ast[] }

export type BinOp = 'or' | 'and' | '=' | '!=' | '<' | '<=' | '>' | '>=' | 'contains' | 'has' | 'in' | '+' | '-' | '*' | '/' | '%'

export class ExprError extends Error {
  constructor(msg: string, public pos: number) { super(msg) }
}

// ---------------------------------------------------------------- tokenizer

type Tok =
  | { k: 'num'; v: number; pos: number }
  | { k: 'str'; v: string; pos: number }
  | { k: 'word'; v: string; pos: number }
  | { k: 'name'; v: string; pos: number }
  | { k: 'op'; v: string; pos: number }
  | { k: 'end'; pos: number }

const OPS = ['<=', '>=', '!=', '<>', '==', '&&', '||', '=', '<', '>', '+', '-', '*', '/', '%', '(', ')', ',', '!']

function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) { i++; continue }
    if (c === '[') {
      const j = src.indexOf(']', i + 1)
      if (j < 0) throw new ExprError('Missing closing ]', i)
      out.push({ k: 'name', v: src.slice(i + 1, j).trim(), pos: i })
      i = j + 1
      continue
    }
    if (c === '"' || c === "'") {
      let j = i + 1
      let s = ''
      while (j < src.length && src[j] !== c) { if (src[j] === '\\' && j + 1 < src.length) j++; s += src[j]; j++ }
      if (j >= src.length) throw new ExprError('Missing closing quote', i)
      out.push({ k: 'str', v: s, pos: i })
      i = j + 1
      continue
    }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i))
    if (num && !/[A-Za-z_]/.test(src[i + num[0].length] ?? '')) {
      out.push({ k: 'num', v: Number(num[0]), pos: i })
      i += num[0].length
      continue
    }
    const op = OPS.find(o => src.startsWith(o, i))
    if (op) { out.push({ k: 'op', v: op, pos: i }); i += op.length; continue }
    const word = /^[^\s()[\],"'=<>!&|+\-*/%]+/.exec(src.slice(i))
    if (word) { out.push({ k: 'word', v: word[0], pos: i }); i += word[0].length; continue }
    throw new ExprError(`Unexpected character "${c}"`, i)
  }
  out.push({ k: 'end', pos: src.length })
  return out
}

// ---------------------------------------------------------------- parser

const KEYWORDS = new Set(['and', 'or', 'not', 'is', 'set', 'empty', 'contains', 'has', 'one', 'of', 'in', 'yes', 'no', 'true', 'false', 'null', 'unset'])
const FUNCTIONS = new Set(['if', 'min', 'max', 'abs', 'round', 'floor', 'ceil', 'len', 'sum', 'avg', 'coalesce', 'lower', 'upper', 'contains', 'empty', 'count'])

export function parse(src: string): Ast {
  const toks = tokenize(src)
  let i = 0
  const peek = () => toks[i]
  const next = () => toks[i++]
  const isWord = (w: string) => { const t = peek(); return t.k === 'word' && t.v.toLowerCase() === w }
  const isOp = (o: string) => { const t = peek(); return t.k === 'op' && t.v === o }
  const expect = (o: string) => { if (!isOp(o)) throw new ExprError(`Expected "${o}"`, peek().pos); next() }

  const or = (): Ast => {
    let a = and()
    while (isWord('or') || isOp('||')) { next(); a = { t: 'bin', op: 'or', a, b: and() } }
    return a
  }
  const and = (): Ast => {
    let a = not()
    while (isWord('and') || isOp('&&')) { next(); a = { t: 'bin', op: 'and', a, b: not() } }
    return a
  }
  const not = (): Ast => {
    if (isWord('not') || isOp('!')) { next(); return { t: 'un', op: 'not', a: not() } }
    return cmp()
  }
  const cmp = (): Ast => {
    const a = add()
    const t = peek()
    if (t.k === 'op') {
      const map: Record<string, BinOp> = { '=': '=', '==': '=', '!=': '!=', '<>': '!=', '<': '<', '<=': '<=', '>': '>', '>=': '>=' }
      const op = map[t.v]
      if (op) { next(); return { t: 'bin', op, a, b: add() } }
      return a
    }
    if (t.k !== 'word') return a
    const w = t.v.toLowerCase()
    if (w === 'is') {
      next()
      let neg = false
      if (isWord('not')) { next(); neg = true }
      if (isWord('set')) { next(); return { t: 'isset', a, set: !neg } }
      if (isWord('empty') || isWord('unset') || isWord('null')) { next(); return { t: 'isset', a, set: neg } }
      throw new ExprError('Expected "set" or "empty" after "is"', peek().pos)
    }
    if (w === 'contains') { next(); return { t: 'bin', op: 'contains', a, b: add() } }
    if (w === 'has') { next(); return { t: 'bin', op: 'has', a, b: add() } }
    if (w === 'in') { next(); return { t: 'bin', op: 'in', a, b: add() } }
    if (w === 'one') {
      next()
      if (!isWord('of')) throw new ExprError('Expected "of" after "one"', peek().pos)
      next()
      return { t: 'bin', op: 'in', a, b: add() }
    }
    return a
  }
  const add = (): Ast => {
    let a = mul()
    while (isOp('+') || isOp('-')) { const op = (next() as { v: string }).v as '+' | '-'; a = { t: 'bin', op, a, b: mul() } }
    return a
  }
  const mul = (): Ast => {
    let a = unary()
    while (isOp('*') || isOp('/') || isOp('%')) { const op = (next() as { v: string }).v as '*' | '/' | '%'; a = { t: 'bin', op, a, b: unary() } }
    return a
  }
  const unary = (): Ast => {
    if (isOp('-')) { next(); return { t: 'un', op: '-', a: unary() } }
    return primary()
  }
  const primary = (): Ast => {
    const t = next()
    switch (t.k) {
      case 'num': return { t: 'num', v: t.v }
      case 'str': return { t: 'str', v: t.v }
      case 'name': return { t: 'name', name: t.v, bracketed: true }
      case 'op':
        if (t.v === '(') {
          const first = or()
          if (isOp(',')) {
            const items = [first]
            while (isOp(',')) { next(); items.push(or()) }
            expect(')')
            return { t: 'list', items }
          }
          expect(')')
          return first
        }
        throw new ExprError(`Unexpected "${t.v}"`, t.pos)
      case 'word': {
        const w = t.v.toLowerCase()
        if (w === 'yes' || w === 'true') return { t: 'bool', v: true }
        if (w === 'no' || w === 'false') return { t: 'bool', v: false }
        if (w === 'null' || w === 'unset') return { t: 'null' }
        if (w === 'empty' && !isOp('(')) return { t: 'null' }
        if (FUNCTIONS.has(w) && isOp('(')) {
          next()
          const args: Ast[] = []
          if (!isOp(')')) { args.push(or()); while (isOp(',')) { next(); args.push(or()) } }
          expect(')')
          return { t: 'call', fn: w, args }
        }
        if (KEYWORDS.has(w)) throw new ExprError(`Unexpected "${t.v}"`, t.pos)
        return { t: 'name', name: t.v, bracketed: false }
      }
      case 'end': throw new ExprError('Unexpected end of expression', t.pos)
    }
  }

  const ast = or()
  if (peek().k !== 'end') throw new ExprError(`Unexpected "${(peek() as { v?: string }).v ?? ''}"`, peek().pos)
  return ast
}

/** Parse, returning the error instead of throwing. */
export function tryParse(src: string): { ast: Ast; error: null } | { ast: null; error: ExprError } {
  try { return { ast: parse(src), error: null } } catch (e) {
    if (e instanceof ExprError) return { ast: null, error: e }
    throw e
  }
}

/** Every name the expression reads (bracketed or bare), in order, without duplicates. */
export function namesIn(ast: Ast): string[] {
  const out: string[] = []
  const walk = (n: Ast) => {
    switch (n.t) {
      case 'name': if (!out.includes(n.name)) out.push(n.name); break
      case 'list': n.items.forEach(walk); break
      case 'un': walk(n.a); break
      case 'bin': walk(n.a); walk(n.b); break
      case 'isset': walk(n.a); break
      case 'call': n.args.forEach(walk); break
      default: break
    }
  }
  walk(ast)
  return out
}

// ---------------------------------------------------------------- evaluator

/** What an expression can read: names resolve to values; `found` false makes a bare word a string. */
export interface Scope {
  get: (name: string) => { found: boolean; value: Value }
}

export const truthy = (v: Value): boolean =>
  v !== null && v !== false && v !== 0 && v !== '' && !(Array.isArray(v) && v.length === 0)

const num = (v: Value): number => {
  if (v === null) return 0
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  if (Array.isArray(v)) return v.length
  const n = Number(String(v).trim().replace(',', '.'))
  return Number.isFinite(n) ? n : NaN
}
const str = (v: Value): string => (v === null ? '' : Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v))
const isNumeric = (v: Value) => typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v.trim().replace(',', '.'))))
const norm = (s: string) => s.trim().toLowerCase()

/** Loose equality: numbers numerically, strings case-insensitively, lists as sets (or membership against a scalar). */
export function looseEqual(a: Value, b: Value): boolean {
  if (a === null || b === null) return (a === null || a === '' || (Array.isArray(a) && !a.length)) && (b === null || b === '' || (Array.isArray(b) && !b.length))
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every(x => b.some(y => norm(x) === norm(y)))
  if (Array.isArray(a)) return a.some(x => looseEqual(x, b))
  if (Array.isArray(b)) return b.some(y => looseEqual(a, y))
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    const toBool = (v: Value) => (typeof v === 'boolean' ? v : isNumeric(v) ? num(v) !== 0 : ['yes', 'true', 'on', 'y'].includes(norm(str(v))) ? true : ['no', 'false', 'off', 'n'].includes(norm(str(v))) ? false : null)
    const x = toBool(a); const y = toBool(b)
    return x !== null && y !== null && x === y
  }
  if (isNumeric(a) && isNumeric(b)) return num(a) === num(b)
  return norm(str(a)) === norm(str(b))
}

function compare(a: Value, b: Value): number | null {
  if (a === null || b === null) return null
  if (isNumeric(a) && isNumeric(b)) return num(a) - num(b)
  if (typeof a === 'boolean' || typeof b === 'boolean') return num(a) - num(b)
  const x = norm(str(a)); const y = norm(str(b))
  return x < y ? -1 : x > y ? 1 : 0
}

function contains(a: Value, b: Value): boolean {
  if (a === null || b === null) return false
  if (Array.isArray(a)) return Array.isArray(b) ? b.every(y => a.some(x => norm(x) === norm(y))) : a.some(x => norm(x) === norm(str(b)))
  return norm(str(a)).includes(norm(str(b)))
}

export function evaluate(ast: Ast, scope: Scope): Value {
  const ev = (n: Ast): Value => {
    switch (n.t) {
      case 'num': return n.v
      case 'str': return n.v
      case 'bool': return n.v
      case 'null': return null
      case 'name': {
        const r = scope.get(n.name)
        if (r.found) return r.value
        // An unknown bare word is text (`Status = blocked`); an unknown [bracketed] name is unset.
        return n.bracketed ? null : n.name
      }
      case 'list': return n.items.map(x => str(ev(x)))
      case 'un': {
        const a = ev(n.a)
        return n.op === 'not' ? !truthy(a) : -num(a)
      }
      case 'isset': {
        // `foo is empty` reads as a question about a field, so an unknown bare name counts as unset here.
        const a = n.a.t === 'name' && !scope.get(n.a.name).found ? null : ev(n.a)
        const set = a !== null && a !== '' && !(Array.isArray(a) && !a.length)
        return n.set ? set : !set
      }
      case 'bin': {
        if (n.op === 'and') { const a = ev(n.a); return truthy(a) ? truthy(ev(n.b)) : false }
        if (n.op === 'or') { const a = ev(n.a); return truthy(a) ? true : truthy(ev(n.b)) }
        const a = ev(n.a)
        const b = ev(n.b)
        switch (n.op) {
          case '=': return looseEqual(a, b)
          case '!=': return !looseEqual(a, b)
          case '<': { const c = compare(a, b); return c !== null && c < 0 }
          case '<=': { const c = compare(a, b); return c !== null && c <= 0 }
          case '>': { const c = compare(a, b); return c !== null && c > 0 }
          case '>=': { const c = compare(a, b); return c !== null && c >= 0 }
          case 'contains': return contains(a, b)
          case 'has': return contains(a, b)
          case 'in': {
            if (b === null) return false
            const list = Array.isArray(b) ? b : [str(b)]
            if (Array.isArray(a)) return a.some(x => list.some(y => norm(x) === norm(y)))
            return a !== null && list.some(y => looseEqual(a, y))
          }
          case '+': {
            if ((typeof a === 'string' && !isNumeric(a)) || (typeof b === 'string' && !isNumeric(b))) return str(a) + str(b)
            return num(a) + num(b)
          }
          case '-': return num(a) - num(b)
          case '*': return num(a) * num(b)
          case '/': { const d = num(b); return d === 0 ? null : num(a) / d }
          case '%': { const d = num(b); return d === 0 ? null : num(a) % d }
        }
        return null
      }
      case 'call': {
        const args = n.args
        const nums = () => args.map(x => num(ev(x))).filter(x => Number.isFinite(x))
        switch (n.fn) {
          case 'if': return truthy(ev(args[0])) ? (args[1] ? ev(args[1]) : true) : (args[2] ? ev(args[2]) : null)
          case 'min': { const l = nums(); return l.length ? Math.min(...l) : null }
          case 'max': { const l = nums(); return l.length ? Math.max(...l) : null }
          case 'sum': return nums().reduce((s, x) => s + x, 0)
          case 'avg': { const l = nums(); return l.length ? l.reduce((s, x) => s + x, 0) / l.length : null }
          case 'abs': return Math.abs(num(ev(args[0])))
          case 'round': { const d = args[1] ? num(ev(args[1])) : 0; const k = Math.pow(10, d); return Math.round(num(ev(args[0])) * k) / k }
          case 'floor': return Math.floor(num(ev(args[0])))
          case 'ceil': return Math.ceil(num(ev(args[0])))
          case 'len':
          case 'count': { const v = ev(args[0]); return v === null ? 0 : Array.isArray(v) ? v.length : str(v).length }
          case 'coalesce': { for (const x of args) { const v = ev(x); if (v !== null && v !== '' && !(Array.isArray(v) && !v.length)) return v } return null }
          case 'lower': return str(ev(args[0])).toLowerCase()
          case 'upper': return str(ev(args[0])).toUpperCase()
          case 'contains': return contains(ev(args[0]), ev(args[1]))
          case 'empty': { const v = ev(args[0]); return v === null || v === '' || (Array.isArray(v) && !v.length) }
        }
        return null
      }
    }
  }
  return ev(ast)
}

// ---------------------------------------------------------------- compiled rules

const cache = new Map<string, { ast: Ast | null; error: string | null }>()

/** Parse once per distinct text; a parse error yields a null ast (rules with errors match everything). */
export function compile(src: string): { ast: Ast | null; error: string | null } {
  const key = src.trim()
  if (!key) return { ast: null, error: null }
  let c = cache.get(key)
  if (!c) {
    const r = tryParse(key)
    c = r.ast ? { ast: r.ast, error: null } : { ast: null, error: r.error.message }
    if (cache.size > 500) cache.clear()
    cache.set(key, c)
  }
  return c
}

/** Quote a field name for use in an expression: bare when it is a plain word, [bracketed] otherwise. */
export function quoteName(name: string): string {
  const n = name.trim()
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && !KEYWORDS.has(n.toLowerCase()) && !FUNCTIONS.has(n.toLowerCase())) return n
  return `[${n.replace(/\]/g, '')}]`
}

/** Quote a literal value: numbers and yes/no bare, anything else in double quotes. */
export function quoteValue(v: string): string {
  const s = v.trim()
  if (s === '') return '""'
  if (/^-?\d+(\.\d+)?$/.test(s)) return s
  if (['yes', 'no', 'true', 'false', 'null', 'empty'].includes(s.toLowerCase())) return s.toLowerCase()
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s) && !KEYWORDS.has(s.toLowerCase()) && !FUNCTIONS.has(s.toLowerCase())) return s
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Render an AST back to text (used by the rule builder to keep text and rows in step). */
export function toText(ast: Ast): string {
  const prec: Record<string, number> = { or: 1, and: 2, '=': 4, '!=': 4, '<': 4, '<=': 4, '>': 4, '>=': 4, contains: 4, has: 4, in: 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 }
  const wrap = (child: Ast, parentPrec: number): string => {
    const s = toText(child)
    const cp = child.t === 'bin' ? prec[child.op] : child.t === 'un' && child.op === 'not' ? 3 : 10
    return cp < parentPrec ? `(${s})` : s
  }
  switch (ast.t) {
    case 'num': return String(ast.v)
    case 'str': return quoteValue(ast.v).startsWith('"') || /^[A-Za-z_]/.test(ast.v) ? `"${ast.v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : quoteValue(ast.v)
    case 'bool': return ast.v ? 'yes' : 'no'
    case 'null': return 'empty'
    case 'name': return ast.bracketed ? `[${ast.name}]` : ast.name
    case 'list': return `(${ast.items.map(toText).join(', ')})`
    case 'un': return ast.op === 'not' ? `not ${wrap(ast.a, 3)}` : `-${wrap(ast.a, 7)}`
    case 'isset': return `${wrap(ast.a, 4)} is ${ast.set ? 'set' : 'empty'}`
    case 'bin': {
      const p = prec[ast.op]
      const opText = ast.op === 'in' ? 'one of' : ast.op
      return `${wrap(ast.a, p)} ${opText} ${wrap(ast.b, p + 1)}`
    }
    case 'call': return `${ast.fn}(${ast.args.map(toText).join(', ')})`
  }
}
