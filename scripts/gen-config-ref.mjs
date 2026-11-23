// Автогенерация референса конфига из DEFAULT_CONFIG в hippocampus.ts
// Использование: node gen-config-ref.mjs <src.ts> [committed.md]
// Без committed.md — печатает таблицу; с ним — сверяет и exit 1 при дрейфе.
import { readFileSync } from 'node:fs'

const [, , srcPath, committed] = process.argv
if (!srcPath) { console.error('usage: gen-config-ref.mjs <src.ts> [committed.md]'); process.exit(2) }
const src = readFileSync(srcPath, 'utf8')

// извлекаем блок DEFAULT_CONFIG (до первого закрывающего `}` в начале строки)
const m = src.match(/const DEFAULT_CONFIG[^{]*=\s*\{([\s\S]*?)\n\}/)
if (!m) { console.error('DEFAULT_CONFIG не найден'); process.exit(2) }

const rows = []
for (const line of m[1].split('\n')) {
  const lm = line.match(/^\s*(\w+):\s*([^,]+?)(?:,\s*(\/\/.*)?)$/)
  if (!lm) continue
  let [, key, val, comment] = lm
  val = val.trim()
  // вычисляем числовые выражения вида "32 * 1024 * 1024"
  if (/^[\d\s*]+$/.test(val)) { try { val = String(Function(`return (${val})`)()) } catch {} }
  rows.push([key, '```' + val + '```', (comment || '').trim()])
}

const md = [
  `<!-- AUTO-GENERATED from ${srcPath.split('/').pop()} — не редактировать вручную -->`,
  '| Ключ | Значение по умолчанию | Примечание |',
  '|---|---|---|',
  ...rows.map(([k, v, c]) => `| \`${k}\` | ${v} | ${c.replace(/\|/g, '\\|')} |`),
].join('\n')

if (!committed) { console.log(md); process.exit(0) }
const old = readFileSync(committed, 'utf8').trim()
if (old === md.trim()) { console.log(`✓ конфиг-референс актуален (${rows.length} ключей)`); process.exit(0) }
console.error('✗ ДРЕЙФ КОНФИГА: референс не соответствует коду. Обновите: node gen-config-ref.mjs ... > ' + committed)
// по-ключевая диффа: какие значения расходятся / ключи добавлены-удалены
const parse = t => Object.fromEntries([...t.matchAll(/^\|\s*`(\w+)`\s*\|\s*(.+?)\s*\|/gm)].map(m => [m[1], m[2]]))
const oldMap = parse(old), newMap = Object.fromEntries(rows.map(([k, v]) => [k, v]))
for (const k of Object.keys(newMap)) if (!(k in oldMap)) console.error(`  + добавлен в код: ${k} = ${newMap[k]}`)
for (const k of Object.keys(oldMap)) {
  if (!(k in newMap)) console.error(`  - удалён из кода: ${k}`)
  else if (oldMap[k] !== newMap[k]) console.error(`  ~ изменено: ${k}: ${oldMap[k]} → ${newMap[k]}`)
}
process.exit(1)
