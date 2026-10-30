// Test helper: bundle a TypeScript module (and its imports) to CJS with
// esbuild and require it, so node --test can exercise renderer logic modules.
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ALIASES = {
  '@shared': resolve('src/shared'),
  '@areas': resolve('src/areas'),
}

export function loadTsModule(path, { external = [] } = {}) {
  const outfile = join(mkdtempSync(join(tmpdir(), 'polypal-test-')), 'module.cjs')
  const result = buildSync({
    entryPoints: [resolve(path)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    alias: ALIASES,
    external,
    logLevel: 'silent',
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return createRequire(import.meta.url)(outfile)
}
