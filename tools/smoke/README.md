# Smoke test against the real DSH toolkit

`node tools/smoke/smoke.mjs` registers all six tools through the **actual
`defineTool` schema compiler** from an installed DeepSeek Harness build, then
drives a complete scan over a throwaway fixture. It is the only pre-device
verification of the plugin contract; run it after any change to
`lib/tools.js`.

It needs three tiny shim packages in `node_modules/` (gitignored, never
shipped). The point of the shims is to load DSH's real schema compiler without
pulling cordis, schemastery, scope, sandbox and the rest of the runtime.

## 1. Extract the real toolkit

On a machine with DSH installed, the packages live inside `app.asar`. Extract
only the type compiler:

```js
// node .tools-extract.mjs -- adjust paths for your install
import fs from 'node:fs'
const ASAR = 'C:/Users/<you>/AppData/Local/Programs/DeepSeek Harness/resources/app.asar'
const OUT = './node_modules/@deepseek-ai/dsh-tools'
const fd = fs.openSync(ASAR, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, 0)
const jsonLen = head.readUInt32LE(12)
const jsonBuf = Buffer.alloc(jsonLen)
fs.readSync(fd, jsonBuf, 0, jsonLen, 16)
const header = JSON.parse(jsonBuf.toString('utf8'))
const dataStart = 16 + jsonLen
let node = header
for (const seg of 'dsh/node_modules/@deepseek-ai/dsh-tools'.split('/')) node = node.files[seg]
const walk = (n, base, out = []) => {
  for (const [name, child] of Object.entries(n.files ?? {})) {
    if (child.files) walk(child, `${base}/${name}`, out)
    else out.push({ rel: `${base}/${name}`, entry: child })
  }
  return out
}
for (const { rel, entry } of walk(node, '')) {
  const dest = OUT + rel
  fs.mkdirSync(dest.slice(0, dest.lastIndexOf('/')) || '.', { recursive: true })
  const buf = Buffer.alloc(Number(entry.size))
  fs.readSync(fd, buf, 0, buf.length, dataStart + Number(entry.offset))
  fs.writeFileSync(dest, buf)
}
```

## 2. Point the package at the schema compiler

`node_modules/@deepseek-ai/dsh-tools/package.json`:

```json
{ "name": "@deepseek-ai/dsh-tools", "version": "0.0.0-smoke", "type": "module", "main": "shim.js", "exports": { ".": "./shim.js" } }
```

`node_modules/@deepseek-ai/dsh-tools/shim.js`:

```js
export { defineTool, parameterSchemaSpecToJsonSchema, valueSchemaSpecToJsonSchema, validateArgs } from './lib/types/schema.js'
```

## 3. Shims for the two leaf dependencies

`node_modules/@deepseek-ai/dsh-llm`:

```json
{ "name": "@deepseek-ai/dsh-llm", "version": "0.0.0-smoke", "type": "module", "main": "index.js", "exports": { ".": "./index.js" } }
```

```js
export class HarnessError extends Error {
  constructor(message, code, details) {
    super(message)
    this.name = 'HarnessError'
    this.code = code
    this.details = details
  }
}
```

`node_modules/@deepseek-ai/dsh-util-values`:

```json
{ "name": "@deepseek-ai/dsh-util-values", "version": "0.0.0-smoke", "type": "module", "main": "index.js", "exports": { ".": "./index.js" } }
```

```js
export function isJsonValue(value) {
  if (value === null) return true
  const type = typeof value
  if (type === 'string' || type === 'boolean') return true
  if (type === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (type === 'object') return Object.values(value).every(isJsonValue)
  return false
}
export function assertNever(value) {
  throw new Error(`unexpected value: ${String(value)}`)
}
```

## 4. Run

```sh
node tools/smoke/smoke.mjs
```

Expected tail: `SMOKE OK`. Anything else is a broken plugin contract — fix it
before shipping, because the device gives far worse error messages.

> Scope note: this harness proves schema compilation, tool execution, SQLite
> persistence, duplicate detection, masking and boundary refusals on the
> development machine. It does **not** prove Android FUSE behaviour, real
> storage permission or DSH profile loading.
