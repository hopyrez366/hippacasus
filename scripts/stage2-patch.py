#!/usr/bin/env python3
"""Stage-2 patch for hippocampus.ts: 2.1 metrics memoization, 2.2 system-block TTL cache,
2.4 O(n) substituteArchivedAttachments, + removal of dead config keys logArgsChars/logToolOutputChars
(stage-1 leftover). Every replacement asserts exactly one occurrence; any miss aborts without writing."""
import sys

PATH = "hippocampus/hippocampus.ts"
with open(PATH, encoding="utf-8") as f:
    src = f.read()

REPLACEMENTS = []

# ---------------------------------------------------------------- 2.1a: PartMetrics + metricsFor + stubFor
REPLACEMENTS.append(("stubFor", '''// Stub with head/tail preview: the full output stays in the raw archive, the stub points at it.
function stubFor(part: Part, filePrefix: string, captures?: Map<string, string>, previewLines = DEFAULT_CONFIG.previewLines): string {
  const out = toolOutput(part, captures)
  const n = estTokens(out)
  let s = `[tool ${part.tool ?? "?"} output (full) → ${filePrefix}#t_${part.callID}, ~${n} tok]`
  const lines = out.split("\\n")
  if (lines.length > previewLines * 2 + 1) {
    s += `\\n--- head ---\\n${lines.slice(0, previewLines).join("\\n")}\\n…[middle omitted — full text in raw file]…\\n--- tail ---\\n${lines.slice(-previewLines).join("\\n")}`
  }
  return s
}''', '''// Per-call metrics cache for buildWindow (stage-2 perf): the same part object is measured by unitSize (base pass, forced pass), renderAssistantMessage and stubFor — without caching each multi-MB output gets a full char-by-char estTokens scan on every one of those passes. Primitives only (never the unit total); keyed by the ORIGINAL part object, not the {...p} clones rendering produces.
type PartMetrics = {
  outStr?: string // toolOutput(p)
  outTok?: number // estTokens(outStr)
  inputJsonTok?: number // estTokens(JSON.stringify(state.input))
  textTok?: number // estTokens(text/reasoning content)
  fileTok?: number // media/file part estimate (b64 size + filename)
  stubStr?: string // lazy: stubFor(p, ...) — built once on first request
  stubTok?: number // lazy: estTokens(stubStr)
}

function metricsFor(metrics: WeakMap<Part, PartMetrics> | undefined, p: Part): PartMetrics {
  if (!metrics) return {}
  let m = metrics.get(p)
  if (!m) {
    m = {}
    metrics.set(p, m)
  }
  return m
}

// Stub with head/tail preview: the full output stays in the raw archive, the stub points at it.
function stubFor(part: Part, filePrefix: string, captures?: Map<string, string>, previewLines = DEFAULT_CONFIG.previewLines, metrics?: WeakMap<Part, PartMetrics>): string {
  const m = metrics ? metricsFor(metrics, part) : undefined
  let out = m?.outStr
  if (out === undefined) {
    out = toolOutput(part, captures)
    if (m) m.outStr = out
  }
  let n = m?.outTok
  if (n === undefined) {
    n = estTokens(out)
    if (m) m.outTok = n
  }
  // Lazy stub: built on first request and cached — unitSize (forced pass) and renderAssistantMessage both probe it for the same part.
  let s = m?.stubStr
  if (s === undefined) {
    s = `[tool ${part.tool ?? "?"} output (full) → ${filePrefix}#t_${part.callID}, ~${n} tok]`
    const lines = out.split("\\n")
    if (lines.length > previewLines * 2 + 1) {
      s += `\\n--- head ---\\n${lines.slice(0, previewLines).join("\\n")}\\n…[middle omitted — full text in raw file]…\\n--- tail ---\\n${lines.slice(-previewLines).join("\\n")}`
    }
    if (m) {
      m.stubStr = s
      m.stubTok = estTokens(s)
    }
  }
  return s
}'''))

# ---------------------------------------------------------------- 2.1b: renderAssistantMessage signature + tool branch
REPLACEMENTS.append(("renderAssistantMessage-sig", '''function renderAssistantMessage(m: Message, active: boolean, canStub: boolean, cfg: HippoConfig, filePrefix: string, captures?: Map<string, string>): Message | null {''',
'''function renderAssistantMessage(m: Message, active: boolean, canStub: boolean, cfg: HippoConfig, filePrefix: string, captures?: Map<string, string>, metrics?: WeakMap<Part, PartMetrics>): Message | null {'''))

REPLACEMENTS.append(("renderAssistantMessage-tool", '''    if (p.type === "tool") {
      const out = toolOutput(p, captures)
      if (canStub && (estTokens(out) > cfg.maxUnitTokens || toolTruncated(p, captures))) {
        parts.push({ ...p, state: { ...(p.state ?? {}), output: stubFor(p, filePrefix, captures, cfg.previewLines) } })
      } else {
        parts.push({ ...p, state: { ...(p.state ?? {}), output: out } })
      }
      continue
    }''', '''    if (p.type === "tool") {
      const m = metrics ? metricsFor(metrics, p) : undefined
      let out = m?.outStr
      if (out === undefined) {
        out = toolOutput(p, captures)
        if (m) m.outStr = out
      }
      let outTok = m?.outTok
      if (outTok === undefined) {
        outTok = estTokens(out)
        if (m) m.outTok = outTok
      }
      if (canStub && (outTok > cfg.maxUnitTokens || toolTruncated(p, captures))) {
        parts.push({ ...p, state: { ...(p.state ?? {}), output: stubFor(p, filePrefix, captures, cfg.previewLines, metrics) } })
      } else {
        parts.push({ ...p, state: { ...(p.state ?? {}), output: out } })
      }
      continue
    }'''))

# ---------------------------------------------------------------- 2.1c: renderUnit signature + passthrough
REPLACEMENTS.append(("renderUnit", '''function renderUnit(unit: Unit, active: boolean, canStub: boolean, cfg: HippoConfig, filePrefix: string, captures?: Map<string, string>): Message[] {
  const out: Message[] = []
  for (const m of unit.messages) {
    if (m.info.role === "user") {
      out.push({ info: m.info, parts: m.parts.map((p) => ({ ...p })) })
      continue
    }
    const rendered = renderAssistantMessage(m, active, canStub, cfg, filePrefix, captures)''',
'''function renderUnit(unit: Unit, active: boolean, canStub: boolean, cfg: HippoConfig, filePrefix: string, captures?: Map<string, string>, metrics?: WeakMap<Part, PartMetrics>): Message[] {
  const out: Message[] = []
  for (const m of unit.messages) {
    if (m.info.role === "user") {
      out.push({ info: m.info, parts: m.parts.map((p) => ({ ...p })) })
      continue
    }
    const rendered = renderAssistantMessage(m, active, canStub, cfg, filePrefix, captures, metrics)'''))

# ---------------------------------------------------------------- 2.1d: unitSize with cached primitives
REPLACEMENTS.append(("unitSize", '''function unitSize(unit: Unit, active: boolean, canStub: boolean, cfg: HippoConfig, filePrefix: string, captures?: Map<string, string>): number {
  let tokens = 0
  for (const m of unit.messages) {
    for (const p of m.parts) {
      if (p.type === "text" || (p.type === "reasoning" && active)) tokens += estTokens(p.text ?? "")
      else if (p.type === "file") {
        // Inline media counts against the cap too: a base64 image in an unanswered user turn is sent to the provider as-is.
        // ~1 token per 8 decoded bytes is a safe overestimate for images/PDFs (real cost varies by model), so big attachments push the unit over the cap and get evicted/stubbed early.
        const u = String(p.url ?? "")
        if (u.startsWith("data:")) {
          const comma = u.indexOf(",")
          const b64len = comma >= 0 ? Math.max(0, u.length - comma - 1) : 0
          tokens += Math.ceil((b64len * 3) / 4 / 8) + estTokens(String(p.filename ?? ""))
        } else if (u) {
          tokens += estTokens(u.slice(0, 500)) + estTokens(String(p.filename ?? ""))
        }
      } else if (p.type === "tool") {
        const out = toolOutput(p, captures)
        tokens += estTokens(JSON.stringify(p.state?.input ?? {}))
        if (canStub && (estTokens(out) > cfg.maxUnitTokens || toolTruncated(p, captures))) tokens += estTokens(stubFor(p, filePrefix, captures, cfg.previewLines))
        else tokens += estTokens(out)
      }
    }
  }
  return tokens
}''', '''function unitSize(unit: Unit, active: boolean, canStub: boolean, cfg: HippoConfig, filePrefix: string, captures?: Map<string, string>, metrics?: WeakMap<Part, PartMetrics>): number {
  let tokens = 0
  for (const m of unit.messages) {
    for (const p of m.parts) {
      if (p.type === "text" || (p.type === "reasoning" && active)) {
        const pm = metrics ? metricsFor(metrics, p) : undefined
        let t = pm?.textTok
        if (t === undefined) {
          t = estTokens(p.text ?? "")
          if (pm) pm.textTok = t
        }
        tokens += t
      } else if (p.type === "file") {
        // Inline media counts against the cap too: a base64 image in an unanswered user turn is sent to the provider as-is.
        // ~1 token per 8 decoded bytes is a safe overestimate for images/PDFs (real cost varies by model), so big attachments push the unit over the cap and get evicted/stubbed early.
        const pm = metrics ? metricsFor(metrics, p) : undefined
        let f = pm?.fileTok
        if (f === undefined) {
          const u = String(p.url ?? "")
          if (u.startsWith("data:")) {
            const comma = u.indexOf(",")
            const b64len = comma >= 0 ? Math.max(0, u.length - comma - 1) : 0
            f = Math.ceil((b64len * 3) / 4 / 8) + estTokens(String(p.filename ?? ""))
          } else if (u) {
            f = estTokens(u.slice(0, 500)) + estTokens(String(p.filename ?? ""))
          } else {
            f = 0
          }
          if (pm) pm.fileTok = f
        }
        tokens += f
      } else if (p.type === "tool") {
        const pm = metrics ? metricsFor(metrics, p) : undefined
        let outStr = pm?.outStr
        if (outStr === undefined) {
          outStr = toolOutput(p, captures)
          if (pm) pm.outStr = outStr
        }
        let inTok = pm?.inputJsonTok
        if (inTok === undefined) {
          inTok = estTokens(JSON.stringify(p.state?.input ?? {}))
          if (pm) pm.inputJsonTok = inTok
        }
        tokens += inTok
        let outTok = pm?.outTok
        if (outTok === undefined) {
          outTok = estTokens(outStr)
          if (pm) pm.outTok = outTok
        }
        if (canStub && (outTok > cfg.maxUnitTokens || toolTruncated(p, captures))) {
          const stub = stubFor(p, filePrefix, captures, cfg.previewLines, metrics)
          let stTok = pm?.stubTok
          if (stTok === undefined) {
            stTok = estTokens(stub)
            if (pm) pm.stubTok = stTok
          }
          tokens += stTok
        } else {
          tokens += outTok
        }
      }
    }
  }
  return tokens
}'''))

# ---------------------------------------------------------------- 2.1e: buildWindow — create WeakMap, pass to all passes
REPLACEMENTS.append(("buildWindow-metrics-create", '''  const freshStart = Math.max(0, units.length - cfg.freshTurns)

  const suffixBase: number[] = new Array(units.length + 1).fill(0)
  for (let i = units.length - 1; i >= 0; i--) {
    suffixBase[i] = suffixBase[i + 1] + unitSize(units[i], i === activeIdx, i < freshStart, cfg, filePrefix, captures)
  }''', '''  const freshStart = Math.max(0, units.length - cfg.freshTurns)

  // Per-call token-metric cache (stage-2 perf): every pass below re-measures the same part objects; memoizing primitives per ORIGINAL part object keeps estTokens math bit-for-bit identical while cutting full scans from O(passes × parts) to O(parts).
  const metrics = new WeakMap<Part, PartMetrics>()

  const suffixBase: number[] = new Array(units.length + 1).fill(0)
  for (let i = units.length - 1; i >= 0; i--) {
    suffixBase[i] = suffixBase[i + 1] + unitSize(units[i], i === activeIdx, i < freshStart, cfg, filePrefix, captures, metrics)
  }'''))

REPLACEMENTS.append(("buildWindow-forced-pass", '''    suffixForce[i] = suffixForce[i + 1] + unitSize(units[i], i === activeIdx, true, cfg, filePrefix, captures)''',
'''    suffixForce[i] = suffixForce[i + 1] + unitSize(units[i], i === activeIdx, true, cfg, filePrefix, captures, metrics)'''))

REPLACEMENTS.append(("buildWindow-render", '''    const rendered = renderUnit(units[i], i === activeIdx, canStub, cfg, filePrefix, captures)''',
'''    const rendered = renderUnit(units[i], i === activeIdx, canStub, cfg, filePrefix, captures, metrics)'''))

# ---------------------------------------------------------------- 2.2a: compileSystemBlock TTL fast path + invalidate
REPLACEMENTS.append(("compileSystemBlock", '''async function compileSystemBlock(worktree: string): Promise<string> {
  const root = hippoRoot(worktree)
  const coreRaw = (await readCoreMemory(root)).trim() || "(empty)"
  const manifest = await memfsManifest(root)
  const t1 = manifest.filter((e) => !e.rel.startsWith(ARCHIVE_SUBDIR + "/"))
  const archivedCount = manifest.length - t1.length
  let wikiCount = 0
  try {
    // stat-only walk — the old code read every page body here on each context call just to get a count.
    wikiCount = (await wikiDiskSig(path.join(root, WIKI_DIR))).n
  } catch {}

  const key = `${worktree}|${sha256hex(coreRaw)}|${t1.map((e) => e.rel + ":" + e.size).join(",")}|${archivedCount}|${wikiCount}`
  const cached = sysBlockCache.get(worktree)
  if (cached && cached.key === key && cached.val !== "") return cached.val''', '''async function compileSystemBlock(worktree: string, ttlMs?: number): Promise<string> {
  const root = hippoRoot(worktree)
  // Fast path (stage-2 perf): a fresh cache entry means nothing tracked can have changed — skip ALL disk access (core read + memfs walk + wiki stat walk). Manual edits to core-memory.md are picked up once the TTL expires.
  const ttl = ttlMs ?? DEFAULT_CONFIG.systemBlockTtlMs
  if (ttl > 0) {
    const fresh = sysBlockCache.get(worktree)
    if (fresh && fresh.val !== "" && Date.now() - fresh.at < ttl) return fresh.val
  }
  const coreRaw = (await readCoreMemory(root)).trim() || "(empty)"
  const manifest = await memfsManifest(root)
  const t1 = manifest.filter((e) => !e.rel.startsWith(ARCHIVE_SUBDIR + "/"))
  const archivedCount = manifest.length - t1.length
  let wikiCount = 0
  try {
    // stat-only walk — the old code read every page body here on each context call just to get a count.
    wikiCount = (await wikiDiskSig(path.join(root, WIKI_DIR))).n
  } catch {}

  const key = `${worktree}|${sha256hex(coreRaw)}|${t1.map((e) => e.rel + ":" + e.size).join(",")}|${archivedCount}|${wikiCount}`
  const cached = sysBlockCache.get(worktree)
  if (cached && cached.key === key && cached.val !== "") {
    // Content unchanged: reuse the built block and refresh the TTL clock so steady-state calls stay on the fast path.
    cached.at = Date.now()
    return cached.val
  }'''))

REPLACEMENTS.append(("compileSystemBlock-cache-set", '''  const val = lines.join("\\n")
  if (sysBlockCache.size > 32) sysBlockCache.clear() // bound: one slot per live project, clear on pathological growth
  sysBlockCache.set(worktree, { key, val })
  return val
}''', '''  const val = lines.join("\\n")
  if (sysBlockCache.size > 32) sysBlockCache.clear() // bound: one slot per live project, clear on pathological growth
  sysBlockCache.set(worktree, { key, val, at: Date.now() })
  return val
}

// Drop the cached system block so the next compileSystemBlock re-reads disk. Called after every successful memory write (hippo_memory_edit / hippo_memfs_write / hippo_wiki_write) and at the end of consolidate — exactly the operations that can change the block's content key. Manual file edits are picked up by TTL expiry instead.
function invalidateSystemBlock(worktree: string): void {
  sysBlockCache.delete(worktree)
}'''))

REPLACEMENTS.append(("sysBlockCache-type", '''const sysBlockCache = new Map<string, { key: string; val: string }>()''',
'''const sysBlockCache = new Map<string, { key: string; val: string; at: number }>()'''))

# ---------------------------------------------------------------- 2.2b: config type / defaults / loadConfig (also removes dead logArgsChars/logToolOutputChars)
REPLACEMENTS.append(("config-type", '''  logArgsChars: number // recall-log truncation for tool args
  logToolOutputChars: number // recall-log truncation for tool outputs''',
'''  systemBlockTtlMs: number // compileSystemBlock cache TTL in ms; a fresh entry is returned without any disk access (0 = disabled, re-check disk on every context call)'''))

REPLACEMENTS.append(("config-defaults", '''  logArgsChars: 1024,
  logToolOutputChars: 4096,''',
'''  systemBlockTtlMs: 5000,'''))

REPLACEMENTS.append(("loadConfig", '''  if (isFiniteNumber(userCfg.logArgsChars) && userCfg.logArgsChars >= 64) out.logArgsChars = Math.min(Math.floor(userCfg.logArgsChars), 1048576)
  if (isFiniteNumber(userCfg.logToolOutputChars) && userCfg.logToolOutputChars >= 64) out.logToolOutputChars = Math.min(Math.floor(userCfg.logToolOutputChars), 1048576)''',
'''  // systemBlockTtlMs: 0 disables the TTL cache (disk re-check on every context call); negative values are rejected.
  if (isFiniteNumber(userCfg.systemBlockTtlMs) && userCfg.systemBlockTtlMs >= 0) out.systemBlockTtlMs = Math.floor(userCfg.systemBlockTtlMs)'''))

# ---------------------------------------------------------------- 2.2c: invalidation call-sites
REPLACEMENTS.append(("invalidate-memory-edit", '''        await auditMemory(worktree, sid, "hippo_memory_edit", norm, "accepted", undefined, oldContent, newContent)
        return { content: `OK — core memory block "${norm}" updated (${res.chars} chars). Effective from the next turn.` }''',
'''        await auditMemory(worktree, sid, "hippo_memory_edit", norm, "accepted", undefined, oldContent, newContent)
        invalidateSystemBlock(worktree) // T0 content changed → rebuild the block on the next context call
        return { content: `OK — core memory block "${norm}" updated (${res.chars} chars). Effective from the next turn.` }'''))

REPLACEMENTS.append(("invalidate-memfs-write", '''        await auditMemory(worktree, sid, "hippo_memfs_write", relPath, "accepted", undefined, oldContent, newContent)
        return { content: `OK — ${relPath} written (${res.bytes} bytes)` }''',
'''        await auditMemory(worktree, sid, "hippo_memfs_write", relPath, "accepted", undefined, oldContent, newContent)
        invalidateSystemBlock(worktree) // T1 manifest (file list/sizes) changed → rebuild the block on the next context call
        return { content: `OK — ${relPath} written (${res.bytes} bytes)` }'''))

REPLACEMENTS.append(("invalidate-wiki-write", '''        await indexWikiPage(root, relPath)
        await auditMemory(r.worktree, r.sid, "hippo_wiki_write", relPath, "accepted", undefined, oldContent, stamped)
        return { content: `OK — wiki page ${relPath} written (${res.bytes} bytes)` }''',
'''        await indexWikiPage(root, relPath)
        await auditMemory(r.worktree, r.sid, "hippo_wiki_write", relPath, "accepted", undefined, oldContent, stamped)
        invalidateSystemBlock(r.worktree) // wiki page count may have changed → rebuild the block on the next context call
        return { content: `OK — wiki page ${relPath} written (${res.bytes} bytes)` }'''))

REPLACEMENTS.append(("invalidate-consolidate", '''  return rep.join("\\n") || "nothing to consolidate"''',
'''  invalidateSystemBlock(worktree) // dedup/archive/SOP steps mutate the wiki+memfs tree → rebuild the block on the next context call
  return rep.join("\\n") || "nothing to consolidate"'''))

# ---------------------------------------------------------------- 2.2d: context hook passes project TTL; internals export
REPLACEMENTS.append(("context-hook-ttl", '''              block = await compileSystemBlock(worktree)''',
'''              block = await compileSystemBlock(worktree, cfg.systemBlockTtlMs)'''))

REPLACEMENTS.append(("internals-export", '''    compileSystemBlock,
    noteFor,''', '''    compileSystemBlock,
    invalidateSystemBlock,
    noteFor,'''))

# ---------------------------------------------------------------- 2.4: substituteArchivedAttachments single right-to-left pass
REPLACEMENTS.append(("substitute-attachments", '''function substituteArchivedAttachments(legacy: Message[]): Message[] {
  return legacy.map((msg, i) => {
    if (msg.info.role !== "user") return msg
    const answered = legacy.slice(i + 1).some((m) => m.info.role === "assistant")
    if (!answered) return msg
    let changed = false
    const parts = msg.parts.map((p, i): Part => {''', '''function substituteArchivedAttachments(legacy: Message[]): Message[] {
  // Single right-to-left pass (stage-2 perf): `answered` = "an assistant message exists strictly after this position". Maintaining it while scanning from the end is O(n) instead of the old per-message legacy.slice(i + 1).some() — O(n²) plus an allocation on every context call.
  const out: Message[] = new Array(legacy.length)
  let answeredAfter = false
  for (let i = legacy.length - 1; i >= 0; i--) {
    const msg = legacy[i]
    if (msg.info.role === "assistant") {
      answeredAfter = true
      out[i] = msg
      continue
    }
    if (msg.info.role !== "user" || !answeredAfter) {
      out[i] = msg
      continue
    }
    let changed = false
    const parts = msg.parts.map((p, i): Part => {'''))

REPLACEMENTS.append(("substitute-attachments-tail", '''      return { id: p.id, type: "text", text: `[attachment saved: ${HIPPO_DIR}/${ATTACH_DIR}/${hash}${extFromMime(mime)}]` }
    })
    if (!changed) return msg
    return { info: msg.info, parts }
  })
}''', '''      return { id: p.id, type: "text", text: `[attachment saved: ${HIPPO_DIR}/${ATTACH_DIR}/${hash}${extFromMime(mime)}]` }
    })
    out[i] = changed ? { info: msg.info, parts } : msg
  }
  return out
}'''))

# ---------------------------------------------------------------- apply
REVERSE = "--reverse" in sys.argv[1:]
for label, old, new in REPLACEMENTS:
    if REVERSE:
        old, new = new, old
    n = src.count(old)
    if n != 1:
        print(f"ABORT: needle '{label}' found {n} times (expected exactly 1)")
        sys.exit(1)
    src = src.replace(old, new)
    print(f"ok: {label}" + (" [reverse]" if REVERSE else ""))

with open(PATH, "w", encoding="utf-8") as f:
    f.write(src)
print("WROTE", PATH)
