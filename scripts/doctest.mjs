// Doctest: выполняет ```bash блоки в .md файлах и падает при любом FAIL
// Использование: node doctest.mjs <file.md>... [--sandbox DIR]
import { readFileSync, mkdirSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
let sandbox = join(tmpdir(), 'hippo-doctest-sandbox')
const si = args.indexOf('--sandbox')
if (si !== -1) { sandbox = args[si + 1]; args.splice(si, 2) }
if (!args.length) { console.error('usage: doctest.mjs <file.md>... [--sandbox DIR]'); process.exit(2) }
mkdirSync(sandbox, { recursive: true }) // изоляция = только cwd (репо по умолчанию не трогается); ФС не огорожена — доверенные доки

let failed = 0
for (const file of args) {
  const md = readFileSync(file, 'utf8')
  const blocks = [...md.matchAll(/```bash\n([\s\S]*?)```/g)].map(m => m[1])
  if (!blocks.length) { console.log(`— ${file}: bash-блоков нет`); continue }
  for (let i = 0; i < blocks.length; i++) {
    const code = blocks[i]
    try {
      // set -e: без него sh возвращает код последней команды и падение в середине блока не видно.
      execSync(`set -e\n${code}`, { cwd: sandbox, timeout: 15000, stdio: 'pipe' })
      console.log(`✓ ${file} блок#${i + 1}: PASS`)
    } catch (e) {
      failed++
      const out = (e.stdout || '') + (e.stderr || '')
      console.error(`✗ ${file} блок#${i + 1}: FAIL${e.killed ? ' (timeout)' : ''}`)
      console.error('   $ ' + code.trim().split('\n')[0])
      if (out.trim()) console.error(out.trim().split('\n').slice(0, 3).map(l => '   | ' + l).join('\n'))
    }
  }
}
process.exit(failed ? 1 : 0)
