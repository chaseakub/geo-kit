import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const CONFIG_FILE = 'geo.config.mjs'

export async function loadConfig(file = CONFIG_FILE, cwd = process.cwd()) {
  const path = resolve(cwd, file)
  if (!existsSync(path)) throw new Error(`geo-kit: ${file} not found in ${cwd}. Run \`geo-kit init\` to create one.`)
  const config = (await import(pathToFileURL(path).href)).default
  if (!config?.site) throw new Error(`geo-kit: ${file} must export default { site: 'https://www.example.com', ... }.`)
  return {
    ...config,
    dist: resolve(cwd, config.dist ?? 'dist'),
    audit: config.audit ? { prompts: 'geo-prompts.json', out: 'geo-audit', ...config.audit } : undefined,
  }
}
