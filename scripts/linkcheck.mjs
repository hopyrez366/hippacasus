// Linkcheck: проверяет относительные .md ссылки и якоря (#anchor) в .md файлах
// Использование: node linkcheck.mjs <dir-or-file.md>...
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'

const roots = process.argv.slice(2)
if (!roots.length) { console.error('usage: linkcheck.mjs <dir-or-file.md>...'); process.exit(2) }

function collect(f) {
  const s = statSync(f)
  if (s.isDirectory()) return readdirSync(f).flatMap(n => collect(join(f, n)))
  return f.endsWith('.md') ? [f] : []
}
const files = roots.flatMap(collect)

// GitHub-слаг заголовка: нижний регистр, пробелы→тиры, без пунктуации
function slug(h) {
  return h.toLowerCase().replace(/^[#>\s]+/, '').trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-').replace(/^-+|-+$/g, '')
}

let bad = 0
for (const file of files) {
  const md = readFileSync(file, 'utf8')
  // якоря этого файла: заголовки ## / ###
  const anchors = new Set([...md.matchAll(/^#{2,6}\s+(.+)$/gm)].map(m => slug(m[1])))
  for (const m of md.matchAll(/\[[^\]]*\]\(([^)\s]+\.md)(#[^)\s]*)?\)/g)) {
    const [ , target, hash ] = m
    if (/^https?:/.test(target)) continue
    const dest = resolve(dirname(file), target)
    try { statSync(dest) } catch { bad++; console.error(`✗ ${file}: битая ссылка → ${target}`); continue }
    if (hash) {
      const dmd = readFileSync(dest, 'utf8')
      const a = new Set([...dmd.matchAll(/^#{2,6}\s+(.+)$/gm)].map(x => slug(x[1])))
      if (!a.has(hash.slice(1))) { bad++; console.error(`✗ ${file}: нет якоря → ${target}${hash}`) }
    }
  }
}
console.log(bad ? `✗ битых ссылок: ${bad}` : `✓ все .md ссылки живы (${files.length} файлов)` )
process.exit(bad ? 1 : 0)
