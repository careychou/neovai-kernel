import fs from 'node:fs'
import path from 'node:path'
import { transform } from 'sucrase'

/** Modules a panel may import by name. The renderer supplies them; everything else must be a relative file. */
import { HOST_GLOBAL, PANEL_MODULE } from './screen'

export const DEFAULT_EXTERNALS = ['react', 'react/jsx-runtime', 'react-dom', PANEL_MODULE]

export { HOST_GLOBAL }

const EXTS = ['', '.tsx', '.ts', '.jsx', '.js', '.json', '/index.tsx', '/index.ts', '/index.jsx', '/index.js']
const REQUIRE = /\brequire\((['"])([^'"]+)\1\)/g

export interface CompileResult { code: string; files: string[] }

/** Thrown when a panel cannot be compiled. `message` lists what to fix. */
export class CompileError extends Error {}

const inside = (root: string, p: string) => p === root || p.startsWith(root + path.sep)

/**
 * Compiles a workspace `.tsx` panel and the relative files it imports into one ES module.
 * The module's default export is the panel's default export. React and other externals are
 * read at load time from `globalThis.__liveUiRequire`, so the panel shares the app's React.
 */
export function compilePanel(root: string, file: string, externals = DEFAULT_EXTERNALS): CompileResult {
  const base = fs.realpathSync(root)
  const defs: string[] = []
  const maps: Record<string, Record<string, string>> = {}
  const seen = new Set<string>()
  const errors: string[] = []

  function resolve(from: string, spec: string): string | null {
    const target = path.resolve(path.dirname(from), spec)
    for (const ext of EXTS) {
      const p = target + ext
      try { if (fs.statSync(p).isFile()) return p } catch { /* try next */ }
    }
    return null
  }

  function add(abs: string) {
    const id = path.relative(base, abs)
    if (seen.has(id)) return id
    seen.add(id)
    const src = fs.readFileSync(abs, 'utf8')
    if (/\.css$/.test(abs)) {
      defs.push(`${JSON.stringify(id)}: function (module) { module.exports = __css(${JSON.stringify(id)}, ${JSON.stringify(src)}) }`)
      return id
    }
    if (abs.endsWith('.json')) {
      defs.push(`${JSON.stringify(id)}: function (module) { module.exports = ${src.trim() || 'null'} }`)
      return id
    }
    let code: string
    try {
      const ts = /\.tsx?$/.test(abs)
      code = transform(src, { transforms: [...(ts ? ['typescript' as const] : []), 'jsx', 'imports'], jsxRuntime: 'automatic', production: true, filePath: abs }).code
    } catch (e: any) {
      errors.push(`${id}: ${e.message}`)
      return id
    }
    const map: Record<string, string> = {}
    for (const m of code.matchAll(REQUIRE)) {
      const spec = m[2]
      if (externals.includes(spec) || spec in map) continue
      if (!spec.startsWith('.')) { errors.push(`${id}: cannot import "${spec}". Panels may import ${externals.join(', ')} or relative workspace files.`); continue }
      const dep = resolve(abs, spec)
      if (!dep) { errors.push(`${id}: cannot find "${spec}"`); continue }
      if (!inside(base, fs.realpathSync(dep))) { errors.push(`${id}: "${spec}" is outside the workspace`); continue }
      if (/\.(scss|less)$/.test(dep)) { errors.push(`${id}: only plain .css files can be imported`); continue }
      map[spec] = add(dep)
    }
    maps[id] = map
    defs.push(`${JSON.stringify(id)}: function (module, exports, require) {\n${code}\n}`)
    return id
  }

  const entryAbs = path.resolve(base, file)
  if (!inside(base, entryAbs)) throw new CompileError(`${file} is outside the workspace`)
  if (!fs.existsSync(entryAbs)) throw new CompileError(`${file} does not exist`)
  const entry = add(fs.realpathSync(entryAbs))
  if (errors.length) throw new CompileError(errors.join('\n'))

  const code = `const __host = globalThis.${HOST_GLOBAL};
function __css(id, text) {
  if (typeof document === 'undefined') return {};
  let el = document.querySelector('style[data-panel-css="' + id + '"]');
  if (!el) { el = document.createElement('style'); el.setAttribute('data-panel-css', id); document.head.appendChild(el); }
  if (el.textContent !== text) el.textContent = text;
  return {};
}
const __defs = {
${defs.join(',\n')}
};
const __maps = ${JSON.stringify(maps)};
const __cache = {};
function __load(id) {
  if (__cache[id]) return __cache[id].exports;
  const module = { exports: {} };
  __cache[id] = module;
  const map = __maps[id] || {};
  __defs[id](module, module.exports, (s) => (s in map ? __load(map[s]) : __host(s)));
  return module.exports;
}
const __entry = __load(${JSON.stringify(entry)});
export default (__entry && __entry.default) || __entry;
`
  return { code, files: [...seen] }
}
