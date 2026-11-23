// Stage-2 perf bench: buildWindow token-metric memoization + compileSystemBlock TTL cache.
// The estTokens/disk-op counters are injected into an in-memory patched COPY of the plugin (written to .typecheck-tmp/),
// never into hippocampus.ts itself — the shipped file stays untouched.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.join(here, "..")
const SRC = process.env.HIPPO_BENCH_SRC ? path.resolve(process.env.HIPPO_BENCH_SRC) : path.join(repoRoot, "hippocampus", "hippocampus.ts")
const PATCHED_DIR = path.join(repoRoot, ".typecheck-tmp")

function injectCounters(src) {
  const patch = (cur, needle, replacement, label) => {
    const n = cur.split(needle).length - 1
    if (n !== 1) throw new Error(`injection failed for ${label}: expected 1 occurrence of needle, found ${n}`)
    return cur.replace(needle, replacement)
  }
  let s = src
  // estTokens call counter: every internal call goes through this definition.
  s = patch(
    s,
    "function estTokens(s: string): number {",
    'function estTokens(s: string): number {\n  ;(globalThis as any).__estCounter.calls += 1; (globalThis as any).__estCounter.chars += s.length',
    "estTokens"
  )
  // Disk-access markers for the three disk walkers used by compileSystemBlock.
  s = patch(
    s,
    "async function readCoreMemory(root: string): Promise<string> {",
    'async function readCoreMemory(root: string): Promise<string> {\n  ;(globalThis as any).__diskOps.core += 1',
    "readCoreMemory"
  )
  s = patch(
    s,
    "async function memfsManifest(root: string): Promise<MemfsEntry[]> {",
    'async function memfsManifest(root: string): Promise<MemfsEntry[]> {\n  ;(globalThis as any).__diskOps.memfs += 1',
    "memfsManifest"
  )
  s = patch(
    s,
    "async function wikiDiskSig(wikiDir: string): Promise<{ n: number; maxM: number }> {",
    'async function wikiDiskSig(wikiDir: string): Promise<{ n: number; maxM: number }> {\n  ;(globalThis as any).__diskOps.wiki += 1',
    "wikiDiskSig"
  )
  return s
}

function writePatched() {
  fs.mkdirSync(PATCHED_DIR, { recursive: true })
  const src = fs.readFileSync(SRC, "utf8")
  const patched = injectCounters(src)
  const out = path.join(PATCHED_DIR, "bench-patched.ts")
  fs.writeFileSync(out, patched)
  return out
}

// Deterministic pseudo-random content (no Math.random): same input on every run.
function randText(i, len) {
  let x = (i * 2654435761) >>> 0
  const rnd = () => {
    x ^= x << 13; x >>>= 0
    x ^= x >> 17
    x ^= x << 5; x >>>= 0
    return (x >>> 0) / 4294967296
  }
  const words = ["alpha", "beta", "gamma", "delta", "epsilon", "запись", "память", "контекст", "окно", "эвакуация", "stub", "marker"]
  let out = ""
  while (out.length < len) {
    const w = words[Math.floor(rnd() * words.length)] + Math.floor(rnd() * 1000)
    out += (out ? " " : "") + w
  }
  return out.slice(0, len)
}

function buildSyntheticHistory(I) {
  const now = 1763000000000 // fixed base: wall-clock timestamps must not leak into the golden hash
  const msgs = []
  let n = 0
  for (let u = 0; u < 200; u++) {
    const uid = `u${String(u).padStart(3, "0")}`
    // user message with a text part
    msgs.push({ info: { id: `m_${uid}_user`, role: "user", time: { created: now + n++, completed: now + n++ } }, parts: [{ id: `p_${uid}_u`, type: "text", text: randText(u, 240) }] })
    // assistant with 5 tool parts (~20KB output each) + a short text part
    const parts = []
    for (let t = 0; t < 5; t++) {
      const callID = `c_${uid}_${t}`
      parts.push({ id: `p_${uid}_t${t}`, type: "tool", tool: t % 2 === 0 ? "shell" : "read", callID, state: { input: { cmd: randText(u * 5 + t, 80) }, output: randText(u * 131 + t, 20480) } })
    }
    parts.push({ id: `p_${uid}_a`, type: "text", text: `done ${u}` })
    msgs.push({ info: { id: `m_${uid}_asst`, role: "assistant", time: { created: now + n++, completed: now + n++ } }, parts })
  }
  // a couple dozen plain text turns at the end (no tools)
  for (let t = 0; t < 24; t++) {
    const id = `xt${t}`
    msgs.push({ info: { id: `m_${id}_u`, role: "user", time: { created: now + n++, completed: now + n++ } }, parts: [{ id: `p_${id}_u`, type: "text", text: randText(9000 + t, 300) }] })
    msgs.push({ info: { id: `m_${id}_a`, role: "assistant", time: { created: now + n++, completed: now + n++ } }, parts: [{ id: `p_${id}_a`, type: "text", text: randText(9500 + t, 300) }] })
  }
  return msgs
}

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]
}

async function benchBuildWindow(I) {
  const msgs = buildSyntheticHistory(I)
  // warm-up (JIT + lazy inits), not measured
  I.buildWindow(msgs, "bench_warmup", 32768)
  const N = 50
  const times = []
  for (let i = 0; i < N; i++) {
    const t0 = process.hrtime.bigint()
    const r = I.buildWindow(msgs, "bench_win", 32768)
    const t1 = process.hrtime.bigint()
    times.push(Number(t1 - t0) / 1e6)
  }
  times.sort((a, b) => a - b)
  // single-call counter sample around one fresh call (same input as the timed runs)
  globalThis.__estCounter.calls = 0
  globalThis.__estCounter.chars = 0
  const last = I.buildWindow(msgs, "bench_win", 32768)
  // Normalize for the identity hash: message.info.time carries bench timestamps; everything else must be byte-identical.
  const normalized = last.messages.map((m) => ({ info: { ...m.info, time: undefined }, parts: m.parts }))
  const messagesJson = JSON.stringify(normalized)
  if (process.argv[4]) fs.writeFileSync(process.argv[4], messagesJson + "\n") // golden snapshot for the identity check
  return {
    N,
    medianMs: percentile(times, 50),
    p95Ms: percentile(times, 95),
    minMs: times[0],
    maxMs: times[times.length - 1],
    estCallsPerBuildWindow: globalThis.__estCounter.calls,
    estCharsScannedPerBuildWindow: globalThis.__estCounter.chars,
    stats: last.stats,
    messagesJsonLen: messagesJson.length,
    messagesSha256: crypto.createHash("sha256").update(messagesJson).digest("hex"),
  }
}

// Stage-3 A/B: same history, back-to-back pairs.
//   A = counter detector (stage-2 design): prevEvict + prevCompactionCount → scans every text part for "[provider compaction]" on each call.
//   B = head tracking (stage-3): windowState { firstId, units, evicted } → compares the head id / unit count, no marker scan.
// Both paths run identical eviction work (same sticky trajectory), so the ratio isolates the detector cost.
async function benchHeadTrack(I) {
  const msgs = buildSyntheticHistory(I)
  const nUnits = I.unitize(msgs).length
  let prevA = 0 // A: caller-side sticky counter state (no markers in this history → count stays 0, prevEvict passes through)
  let stateB = { firstId: msgs[0].info.id, units: nUnits, evicted: 0 } // B: persisted head-tracking state
  const inputChars = JSON.stringify(msgs).length

  // warm-up both paths (JIT + lazy inits), not measured
  for (let w = 0; w < 3; w++) {
    const ra = I.buildWindow(msgs, "ht_warm_a", 32768, undefined, undefined, undefined, undefined, prevA, 0)
    prevA = ra.stats.evictedCount
    const rb = I.buildWindow(msgs, "ht_warm_b", 32768, undefined, undefined, undefined, undefined, undefined, undefined, stateB)
    stateB = { firstId: rb.stats.firstId, units: rb.stats.units, evicted: rb.stats.evictedCount }
  }

  const N = 50
  const ratios = [] // per pair: B_ms / A_ms (<1 → head tracking faster)
  const aTimes = [], bTimes = []
  let trajectoriesMatch = true
  let lastAEst = null, lastBEst = null
  for (let i = 0; i < N; i++) {
    globalThis.__estCounter.calls = 0
    globalThis.__estCounter.chars = 0
    let t0 = process.hrtime.bigint()
    const rA = I.buildWindow(msgs, "ht_a", 32768, undefined, undefined, undefined, undefined, prevA, 0)
    let t1 = process.hrtime.bigint()
    const aMs = Number(t1 - t0) / 1e6
    const aEst = { calls: globalThis.__estCounter.calls, chars: globalThis.__estCounter.chars }

    globalThis.__estCounter.calls = 0
    globalThis.__estCounter.chars = 0
    t0 = process.hrtime.bigint()
    const rB = I.buildWindow(msgs, "ht_b", 32768, undefined, undefined, undefined, undefined, undefined, undefined, stateB)
    t1 = process.hrtime.bigint()
    const bMs = Number(t1 - t0) / 1e6
    const bEst = { calls: globalThis.__estCounter.calls, chars: globalThis.__estCounter.chars }

    // Sanity: identical eviction work on both paths (same sticky trajectory, same rendering).
    if (rA.stats.evictedCount !== rB.stats.evictedCount || rA.stats.totalTokens !== rB.stats.totalTokens) trajectoriesMatch = false
    prevA = rA.stats.evictedCount
    stateB = { firstId: rB.stats.firstId, units: rB.stats.units, evicted: rB.stats.evictedCount }

    aTimes.push(aMs); bTimes.push(bMs)
    if (aMs > 0 && isFinite(bMs / aMs)) ratios.push(bMs / aMs)
    lastAEst = aEst; lastBEst = bEst
  }
  const sorted = [...ratios].sort((x, y) => x - y)
  return {
    N,
    inputChars,
    medianRatioBOverA: percentile(sorted, 50),
    p95RatioBOverA: percentile(sorted, 95),
    aMedianMs: percentile([...aTimes].sort((x, y) => x - y), 50),
    bMedianMs: percentile([...bTimes].sort((x, y) => x - y), 50),
    // Counter samples from the final pair's calls: eviction work is identical by construction → estTokens/chars must match (the marker scan does not go through estTokens).
    trajectoriesMatch,
    evictedCount: stateB.evicted,
    lastPairEstCallsA: lastAEst?.calls ?? null,
    lastPairEstCharsA: lastAEst?.chars ?? null,
    lastPairEstCallsB: lastBEst?.calls ?? null,
    lastPairEstCharsB: lastBEst?.chars ?? null,
  }
}

async function benchSystemBlock(I) {
  // synthetic worktree: 300 memfs files + 300 wiki pages + core memory
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "hippo-bench-sys-"))
  const root = path.join(wt, ".hippocampus")
  fs.mkdirSync(path.join(root, "memfs", "work"), { recursive: true })
  fs.mkdirSync(path.join(root, "wiki", "concepts"), { recursive: true })
  fs.writeFileSync(path.join(root, "core-memory.md"), "# core\n## PERSONA\nbench persona\n")
  for (let i = 0; i < 300; i++) {
    fs.writeFileSync(path.join(root, "memfs", "work", `note-${String(i).padStart(3, "0")}.md`), randText(i + 100000, 512))
    const fm = `---\ntitle: Page ${i}\ntype: concept\ndescription: bench page ${i}\nrecorded_at: 2026-11-01T00:00:00Z\n---\n\n${randText(i + 200000, 700)}\n`
    fs.writeFileSync(path.join(root, "wiki", "concepts", `page-${String(i).padStart(3, "0")}.md`), fm)
  }
  const resetDisk = () => { globalThis.__diskOps.core = 0; globalThis.__diskOps.memfs = 0; globalThis.__diskOps.wiki = 0 }

  // cold: empty cache
  resetDisk()
  let t0 = process.hrtime.bigint()
  const cold1 = await I.compileSystemBlock(wt, 5000)
  const coldMs = Number(process.hrtime.bigint() - t0) / 1e6
  const coldOps = { ...globalThis.__diskOps }

  // warm within TTL (default ttl when arg omitted is DEFAULT_CONFIG.systemBlockTtlMs = 5000 pre-change; pass explicitly post-change)
  resetDisk()
  t0 = process.hrtime.bigint()
  const warm1 = await I.compileSystemBlock(wt, 5000)
  const warmMs = Number(process.hrtime.bigint() - t0) / 1e6
  const warmOps = { ...globalThis.__diskOps }

  // second warm call (cache definitely populated from the first warm call's at-timestamp)
  resetDisk()
  t0 = process.hrtime.bigint()
  const warm2 = await I.compileSystemBlock(wt, 5000)
  const warm2Ms = Number(process.hrtime.bigint() - t0) / 1e6
  const warm2Ops = { ...globalThis.__diskOps }

  // invalidation: after invalidateSystemBlock the next call must hit disk again (if the function exists)
  let invalidated = null
  if (typeof I.invalidateSystemBlock === "function") {
    I.invalidateSystemBlock(wt)
    resetDisk()
    t0 = process.hrtime.bigint()
    const afterInval = await I.compileSystemBlock(wt, 5000)
    invalidated = { ms: Number(process.hrtime.bigint() - t0) / 1e6, ops: { ...globalThis.__diskOps }, sameValue: afterInval === cold1 }
  }

  // multi-project isolation: a second worktree must not be served from the first one's slot
  const wt2 = fs.mkdtempSync(path.join(os.tmpdir(), "hippo-bench-sys-"))
  fs.mkdirSync(path.join(wt2, ".hippocampus", "memfs"), { recursive: true })
  fs.writeFileSync(path.join(wt2, ".hippocampus", "core-memory.md"), "# core\n## PERSONA\nsecond project persona\n")
  const other = await I.compileSystemBlock(wt2, 5000)

  return { coldMs, coldOps, warmMs, warmOps, warm2Ms, warm2Ops, invalidated, multiProjectDistinct: other.includes("second project persona"), blockLen: cold1.length }
}

const mode = process.argv[2] ?? "all"
process.env.HIPPO_TEST = "1"
const patchedPath = writePatched()
;globalThis.__estCounter = { calls: 0, chars: 0 }
;globalThis.__diskOps = { core: 0, memfs: 0, wiki: 0 }
await import(patchedPath)
const I = globalThis.__hippoInternals

if (!I || !I.buildWindow) throw new Error("patched module did not expose __hippoInternals")

const out = { mode, node: process.version }
if (mode === "all" || mode === "window") out.window = await benchBuildWindow(I)
if (mode === "all" || mode === "sysblock") out.systemBlock = await benchSystemBlock(I)
if (mode === "all" || mode === "headtrack") out.headTrack = await benchHeadTrack(I)

const json = JSON.stringify(out, null, 2)
console.log(json)
const outFile = process.argv[3]
if (outFile) fs.writeFileSync(outFile, json + "\n")
