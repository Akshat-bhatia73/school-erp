/**
 * Bundles the API for a Vercel Function. The workspace packages publish
 * TypeScript sources, which the function runtime cannot load from
 * node_modules, so they are compiled into one file here. Packages from the
 * registry stay external and are traced from node_modules as usual.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { build } from 'esbuild'

const api = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(path.join(api, 'package.json'), 'utf8'))
const external = Object.keys(manifest.dependencies).filter(
  (name) => !name.startsWith('@erp/'),
)

await build({
  entryPoints: [path.join(api, 'src/vercel.ts')],
  outfile: path.join(api, 'dist/vercel.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  external,
  // No source maps: a map would carry the sources into the deployment.
  sourcemap: false,
  logLevel: 'info',
})
