// I18n-coverage: сверяет RU (основное) и EN (перевод) деревья доков по .md файлам
// Использование: node i18n-coverage.mjs <ru-dir> <en-dir> [--warn]
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const [ruDir, enDir, flag] = process.argv.slice(2)
if (!ruDir || !enDir) { console.error('usage: i18n-coverage.mjs <ru-dir> <en-dir> [--warn]'); process.exit(2) }
// Пока двуязычное дерево не создано — мягкий skip, чтобы CI не падал на одноязычном репо.
for (const d of [ruDir, enDir]) {
  if (!existsSync(d)) { console.log(`⚠ i18n-coverage: каталог ${d} не найден — проверка пропущена`); process.exit(0) }
}
const warnOnly = flag === '--warn'

function tree(dir, base = dir) {
  const out = new Set()
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) for (const f of tree(p, base)) out.add(f)
    else if (n.endsWith('.md')) out.add(relative(base, p))
  }
  return out
}

const ru = tree(ruDir), en = tree(enDir)
let missingEn = [...ru].filter(f => !en.has(f)).sort()
let missingRu = [...en].filter(f => !ru.has(f)).sort()

if (!missingEn.length && !missingRu.length) { console.log(`✓ i18n покрытие полное (${ru.size} страниц)`); process.exit(0) }
for (const f of missingEn) console.error(`${warnOnly ? '⚠' : '✗'} нет перевода EN: ${f}`)
for (const f of missingRu) console.error(`? лишний в EN (нет RU): ${f}`)
console.log(`${missingEn.length + missingRu.length} расхождений${warnOnly ? ' (--warn: exit 0)' : ''}`)
// --warn downgrades every mismatch to a warning (audit round-3 #15: it used to still fail on missing translations).
process.exit(warnOnly ? 0 : 1)
