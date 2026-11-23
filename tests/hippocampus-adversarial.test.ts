// Adversarial QA suite for hippocampus/hippocampus.ts — PART 1 of the audit.
// 25 core functions × 3 tests each = 75 tests, exact assertions only (no "looks plausible").
// Run from repo root: node --experimental-strip-types --test "tests/*.ts"
import { describe, it, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"

process.env.HIPPO_TEST = "1"
await import("../hippocampus/hippocampus.ts")
const I = (globalThis as any).__hippoInternals
if (!I) throw new Error("internals not exported — HIPPO_TEST=1 must be set before importing hippocampus.ts")

// ---------------------------------------------------------------- helpers
const tmps: string[] = []
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "hippo-qa-"))
  tmps.push(d)
  return d
}
after(() => {
  I.closeAllWikiDbs?.() // Windows: an open index.db handle blocks rm of the temp dir with EBUSY (POSIX unlinks open files fine)
  for (const t of tmps) fs.rmSync(t, { recursive: true, force: true })
})

function mkWorktree(): string {
  const wt = tmp()
  fs.mkdirSync(path.join(wt, ".hippocampus", "memfs"), { recursive: true })
  return wt
}

// legacy-format message builders (the internal Message shape)
const U = (id: string, text: string): any => ({ info: { id, role: "user", time: { created: Date.now() } }, parts: [{ id: `p_${id}`, type: "text", text }] })
const A_TOOL = (id: string, tool: string, callID: string, out: string, extra?: any): any => ({
  info: { id, role: "assistant", time: { created: Date.now(), completed: Date.now() } },
  parts: [{ id: `p_${id}`, type: "tool", tool, callID, state: { input: {}, output: out } as any, ...(extra ?? {}) }],
})

const CFG = { markerBudgetTokens: 1000, capRatio: 0.25, hysteresis: 0.7, maxUnitTokens: 4000, freshTurns: 2 } as any

// ================================================================ 1/25 estTokens
describe("estTokens", () => {
  it("ascii-only text: ceil(len / 3.5)", () => {
    assert.equal(I.estTokens("hello"), 2) // ceil(5/3.5)=ceil(1.4286)=2
    assert.equal(I.estTokens(""), 0)
    assert.equal(I.estTokens("x".repeat(7)), 2) // exactly 2.0 → ceil = 2
  })
  it("cyrillic (U+0400–U+04FF): counted at /2 per char", () => {
    assert.equal(I.estTokens("привет"), 3) // ceil(6/2)=3
    assert.equal(I.estTokens("а".repeat(1)), 1)
  })
  it("mixed cyrillic+ascii: ceil(cyr/2 + rest/3.5)", () => {
    assert.equal(I.estTokens("aбвгд"), 3) // ceil(0.2857 + 2.5) = 3
    const s = "аб" + "c".repeat(10) // cyr=2, rest=10 → ceil(1 + 2.857)=4
    assert.equal(I.estTokens(s), 4)
  })
})

// ================================================================ 2/25 redactSecrets
describe("redactSecrets", () => {
  it("provider token prefixes (sk-/ghp_/AKIA) are replaced with [REDACTED]", () => {
    const sk = "sk-abcDEF123456789xyz" // prefix + 18 valid chars
    const gh = "ghp_" + "a".repeat(20)
    const akia = "AKIAA1B2C3D4E5F6G7H8"
    for (const tok of [sk, gh, akia]) {
      const out = I.redactSecrets(`value ${tok} end`)
      assert.ok(!out.includes(tok), `token leaked: ${tok}`)
      assert.ok(out.includes("[REDACTED]"), "expected [REDACTED]")
    }
  })
  it("Bearer/JWT/URL-credentials are redacted; near-misses survive", () => {
    assert.equal(I.redactSecrets("hdr Bearer abcdefghijklmnop end"), "hdr Bearer [REDACTED] end") // exactly 16 chars → redacted
    assert.ok(!I.redactSecrets("Bearer abcdefghijklmno").includes("[REDACTED]")) // 15 chars → NOT redacted
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
    assert.ok(!I.redactSecrets(`tok ${jwt}!`).includes(jwt))
    const url = "https://user:hunter2@host/path?q=1"
    assert.equal(I.redactSecrets(url), "https://user:[REDACTED]@host/path?q=1")
  })
  it("quoted sensitive keys and unquoted env-style KEY=VALUE redacted; unrelated values survive", () => {
    const json = '{"api_key": "supersecret123", "note": "keep me"}'
    assert.equal(I.redactSecrets(json), '{"api_key": "[REDACTED]", "note": "keep me"}')
    assert.equal(I.redactSecrets("FOO=bar MY_TOKEN=s3cr3tValue9"), "FOO=bar MY_TOKEN=[REDACTED]")
  })
})

// ================================================================ 3/25 normalizeLabel
describe("normalizeLabel", () => {
  it("trims, uppercases, maps non-alnum to underscore", () => {
    assert.equal(I.normalizeLabel(" human notes "), "HUMAN_NOTES")
    assert.equal(I.normalizeLabel("weird!!label--x"), "WEIRD__LABEL--X") // dashes kept, '!' → '_'
  })
  it("truncates to 40 chars", () => {
    assert.equal(I.normalizeLabel("a".repeat(50)), "A".repeat(40))
  })
  it("empty/whitespace-only label normalizes to empty string (rejected upstream)", () => {
    assert.equal(I.normalizeLabel(""), "")
    assert.equal(I.normalizeLabel("   "), "")
  })
})

// ================================================================ 4/25 setCoreMemoryBlock
describe("setCoreMemoryBlock", () => {
  it("appends a new block / replaces an existing one in place, other blocks untouched", async () => {
    const root = tmp()
    fs.writeFileSync(path.join(root, "core-memory.md"), "## PERSONA\np-line\n\n## HUMAN\n(nothing recorded yet)\n")
    const r = await I.setCoreMemoryBlock(root, "human", "user prefers short answers")
    assert.equal(r.chars, 26)
    const file = fs.readFileSync(path.join(root, "core-memory.md"), "utf8")
    assert.ok(file.includes("## PERSONA\np-line"), "PERSONA must survive")
    assert.ok(file.includes("## HUMAN\nuser prefers short answers"))
    assert.equal(await I.readCoreBlock(root, "HUMAN"), "user prefers short answers")
  })
  it("rejects content > 4000 chars and empty labels", async () => {
    const root = tmp()
    const r1 = await I.setCoreMemoryBlock(root, "NOTES", "x".repeat(4001))
    assert.match(r1.error ?? "", /content too long \(4001 chars, max 4000\)/)
    const r2 = await I.setCoreMemoryBlock(root, "   ", "hello")
    assert.equal(r2.error, "invalid block label")
  })
  it("refuses growth beyond maxChars (shrinking always allowed); '## ' lines in content are escaped", async () => {
    const root = tmp()
    const r1 = await I.setCoreMemoryBlock(root, "NOTES", "x".repeat(100), { maxChars: 50 })
    assert.match(r1.error ?? "", /core memory would exceed limit \(\d+ chars, max 50\)/)
    // pre-existing large block → shrinking edit must be allowed even under the same limit
    fs.writeFileSync(path.join(root, "core-memory.md"), `## NOTES\n${"y".repeat(200)}\n`)
    const r2 = await I.setCoreMemoryBlock(root, "NOTES", "small", { maxChars: 50 })
    assert.equal(r2.error, undefined)
    // injection via block header in content must be neutralized with '> ' prefix
    fs.rmSync(path.join(root, "core-memory.md"))
    await I.setCoreMemoryBlock(root, "NOTES", "line one\n## INJECT\nline three")
    const file = fs.readFileSync(path.join(root, "core-memory.md"), "utf8")
    assert.ok(file.includes("> ## INJECT"), "block header in content must be escaped")
    assert.ok(!/^## INJECT/m.test(file), "escaped header must not become a real block")
  })
})

// ================================================================ 5/25 readCoreBlock
describe("readCoreBlock", () => {
  it("returns exact block text, trailing blank lines trimmed", async () => {
    const root = tmp()
    fs.writeFileSync(path.join(root, "core-memory.md"), "## PERSONA\np1 line one\np1 line two\n\n## HUMAN\nh1\n")
    assert.equal(await I.readCoreBlock(root, "PERSONA"), "p1 line one\np1 line two")
    assert.equal(await I.readCoreBlock(root, "HUMAN"), "h1")
  })
  it("missing label → empty string", async () => {
    const root = tmp()
    fs.writeFileSync(path.join(root, "core-memory.md"), "## PERSONA\np\n")
    assert.equal(await I.readCoreBlock(root, "NOPE"), "")
  })
  it("missing file → empty string (no throw)", async () => {
    const root = tmp()
    assert.equal(await I.readCoreBlock(root, "PERSONA"), "")
  })
})

// ================================================================ 6/25 escapeArchiveLine
describe("escapeArchiveLine", () => {
  it("structural prefixes are backslash-escaped", () => {
    assert.equal(I.escapeArchiveLine("## u_abc"), "\\## u_abc")
    assert.equal(I.escapeArchiveLine("### t_xyz"), "\\### t_xyz")
    assert.equal(I.escapeArchiveLine("<!-- m_m9 -->"), "\\<!-- m_m9 -->")
  })
  it("non-structural lines are unchanged (regex is anchored)", () => {
    assert.equal(I.escapeArchiveLine("hello ## u_not a prefix"), "hello ## u_not a prefix")
    assert.equal(I.escapeArchiveLine("##u_no_space"), "##u_no_space") // no space → not structural
  })
  it("escaped lines round-trip: unescape restores original", () => {
    const orig = ["## u_x", "### t_y", "<!-- m_z -->", "plain"]
    const escaped = orig.map(I.escapeArchiveLine)
    assert.deepEqual(escaped, ["\\## u_x", "\\### t_y", "\\<!-- m_z -->", "plain"])
    // reader-side inverse: exactly one leading backslash is stripped from escaped structural lines only
    assert.deepEqual(escaped.map(I.unescapeArchiveLine), orig)
    assert.equal(I.unescapeArchiveLine("hello \\## u_not a prefix"), "hello \\## u_not a prefix") // not line-initial → untouched
  })
})

// ================================================================ 7/25 messageLines (archive serialization + redaction)
describe("messageLines", () => {
  it("user text: anchor comment, [user] tag, secrets redacted in archive copy", () => {
    const m = U("mU", "use sk-abcdefghij12345678 now")
    const lines = I.messageLines(m)
    assert.equal(lines[0], "<!-- m_mU -->")
    assert.ok(lines.includes("[user]"))
    assert.ok(lines.some((l: string) => l === "use [REDACTED] now"), `secret must be redacted, got: ${JSON.stringify(lines)}`)
    assert.ok(!lines.some((l: string) => l.includes("sk-abcdefghij")))
  })
  it("read of a sensitive file (.env/id_rsa/*.pem/credentials.json): output withheld in archive", () => {
    const m = A_TOOL("mS", "read", "c1", "SECRET=abc")
    m.parts[0].state.input = { filePath: ".env" }
    const lines = I.messageLines(m) as string[]
    assert.ok(lines.includes("[withheld: sensitive file]"), JSON.stringify(lines))
    assert.ok(!lines.some((l: string) => l.includes("SECRET=abc")))
    assert.ok(lines.some((l: string) => l.startsWith("### t_c1 · read · ")))
  })
  it("structural-looking lines in content are escaped; full tool output stored lossless under ### t_<id>", () => {
    const m = A_TOOL("mA", "bash", "c2", "out line 1\n### t_evil fake header\nout line 3")
    ;(m as any).parts.push({ id: "p_txt", type: "text", text: "## u_fake" })
    const lines = (I.messageLines(m) as string[]).flatMap((l: string) => l.split("\n")) // esc() embeds newlines inside single elements
    assert.ok(lines.includes("\\## u_fake"), "assistant text structural line must be escaped")
    assert.ok(!lines.some((l: string) => l === "## u_fake"))
    assert.ok(lines.includes("### t_c2 · bash · (~" + I.estTokens("out line 1\n### t_evil fake header\nout line 3") + " tok)"))
    assert.ok(lines.includes("\\### t_evil fake header"), "tool output structural line must be escaped in archive")
  })
})

// ================================================================ 8/25 unitize
describe("unitize", () => {
  it("user message starts a new unit; following assistant messages join it", () => {
    const units = I.unitize([U("u1", "q"), A_TOOL("a1", "bash", "c1", "o"), A_TOOL("a2", "bash", "c2", "o")])
    assert.equal(units.length, 1)
    assert.equal(units[0].id, "u1")
    assert.equal(units[0].messages.length, 3)
  })
  it("two user messages → two units with correct ids and membership", () => {
    const units = I.unitize([U("u1", "q1"), A_TOOL("a1", "bash", "c1", "o"), U("u2", "q2")])
    assert.equal(units.length, 2)
    assert.deepEqual(units.map((u: any) => u.id), ["u1", "u2"])
    assert.equal(units[0].messages.length, 2)
    assert.equal(units[1].messages.length, 1)
  })
  it("empty input → empty output (no crash)", () => {
    assert.deepEqual(I.unitize([]), [])
  })
})

// ================================================================ 9/25 stubFor (head/tail preview stubs)
describe("stubFor", () => {
  const part = (out: string): any => ({ id: "p1", type: "tool", tool: "bash", callID: "c1", state: { output: out } })
  it("long output → pointer + head(3)/tail(3) preview, middle omitted", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `L${String(i + 1).padStart(2, "0")}`)
    const out = lines.join("\n")
    const s = I.stubFor(part(out), ".hippocampus/raw/ses_x.md")
    assert.ok(s.startsWith(`[tool bash output (full) → .hippocampus/raw/ses_x.md#t_c1, ~${I.estTokens(out)} tok]`))
    assert.ok(s.includes("--- head ---\nL01\nL02\nL03"))
    assert.ok(s.includes("…[middle omitted — full text in raw file]…"))
    assert.ok(s.includes("--- tail ---\nL18\nL19\nL20"))
    for (const mid of ["L04", "L05", "L17"]) assert.ok(!s.includes(mid), `${mid} must not appear in stub`)
  })
  it("short output (≤ 7 lines) → no preview section at all", () => {
    const s = I.stubFor(part(["a", "b", "c"].join("\n")), ".hippocampus/raw/ses_x.md")
    assert.ok(!s.includes("--- head ---"))
    assert.ok(s.startsWith("[tool bash output (full) → .hippocampus/raw/ses_x.md#t_c1, ~"))
  })
  it("capture store wins over truncated stored output (lossless recovery)", () => {
    const full = Array.from({ length: 20 }, (_, i) => `F${i}`).join("\n")
    const p = part("truncated-prefix...") // what the session kept
    const captures = new Map<string, string>([["c1", full]])
    const s = I.stubFor(p, ".hippocampus/raw/ses_x.md", captures)
    assert.ok(s.includes(`~${I.estTokens(full)} tok`), "token count must come from the captured full output")
    assert.ok(s.includes("F0\nF1\nF2"), "head preview must come from capture")
  })
})

// ================================================================ 10/25 markerBlock (eviction markers)
describe("markerBlock", () => {
  const unit = (id: string, text: string): any => ({ id, messages: [U(`m_${id}`, text)] })
  it("one evicted unit → per-unit offload line + pull-back footer", () => {
    const s = I.markerBlock([unit("u1", "Fix the login bug now.")], ".hippocampus/raw/ses_x.md", CFG)
    assert.ok(s.includes('[offloaded → .hippocampus/raw/ses_x.md#u_u1 — "Fix the login bug now"]'), s)
    assert.ok(s.includes("(pull any segment back with hippo_lookup: target 'u_<id>' or a ':<start>-<end>' line range)"))
  })
  it("many units over markerBudgetTokens → single summary line (no per-unit lines)", () => {
    const evicted = Array.from({ length: 60 }, (_, i) => unit(`u${i + 1}`, `This is a fairly long user question number ${i + 1} with many extra words to inflate the marker size beyond budget`))
    const s = I.markerBlock(evicted, ".hippocampus/raw/ses_x.md", { ...CFG, markerBudgetTokens: 100 })
    assert.ok(s.startsWith("[60 segments offloaded: u1…u60 → .hippocampus/raw/ses_x.md — TOC:"), s.slice(0, 80))
    assert.ok(!s.includes('[offloaded →'), "per-unit lines must be suppressed in summary mode")
  })
  it("empty eviction list → empty string", () => {
    assert.equal(I.markerBlock([], ".hippocampus/raw/ses_x.md", CFG), "")
  })
})

// ================================================================ 11/25 buildWindow (the evictor)
describe("buildWindow", () => {
  it("under cap: nothing evicted, no forced pass, all messages preserved verbatim", () => {
    const msgs = [U("u1", "alpha question"), U("u2", "beta question"), U("u3", "gamma question")]
    const r = I.buildWindow(msgs, "ses_small", 4000) // cap = floor(4000*0.25) = 1000
    assert.equal(r.stats.evictedCount, 0)
    assert.equal(r.stats.forced, false)
    assert.equal(r.messages.length, msgs.length)
    const texts = r.messages.flatMap((m: any) => m.parts.map((p: any) => p.text ?? ""))
    for (const t of ["alpha question", "beta question", "gamma question"]) assert.ok(texts.includes(t))
  })
  it("over cap: oldest units evicted to marker; evicted content absent from window", () => {
    const bigFor = (i: number): string => `U${i}-` + "x".repeat(2095) // unique per unit, estTokens ≈ 600
    const msgs: any[] = []
    for (let i = 0; i < 8; i++) {
      msgs.push(U(`u${i}`, `EVICTME_${i} question`))
      msgs.push(A_TOOL(`a${i}`, "bash", `c${i}`, bigFor(i)))
    }
    const r = I.buildWindow(msgs, "ses_evict", 4000) // cap=1000, target=700
    assert.ok(r.stats.evictedCount >= 1, `expected eviction, got stats=${JSON.stringify(r.stats)}`)
    const allText = r.messages.flatMap((m: any) => m.parts.map((p: any) => p.text ?? ""))
    const allOut = r.messages.flatMap((m: any) => m.parts.map((p: any) => String(p.state?.output ?? "")))
    assert.ok(allText.some((t: string) => t.includes("[offloaded → .hippocampus/raw/ses_evict.md#u_")), "marker line must be injected")
    // exact match: the marker legitimately quotes the hint, so check no full user text part survives;
    // fresh units (last 2) may legally keep their full outputs, so only evicted ones are checked
    for (let i = 0; i < r.stats.evictedCount; i++) {
      assert.ok(!allText.some((t: string) => t === `EVICTME_${i} question`), `evicted unit u${i} user message must not survive`)
      assert.ok(!allOut.includes(bigFor(i)), `evicted unit u${i} tool output must not survive (fresh units may keep theirs)`)
    }
  })
  it("sticky eviction (never un-evict) + written-guard blocks eviction of unwritten units", () => {
    const big = "x".repeat(2100)
    const msgs: any[] = []
    for (let i = 0; i < 8; i++) {
      msgs.push(U(`u${i}`, `Q_${i}`))
      msgs.push(A_TOOL(`a${i}`, "bash", `c${i}`, big))
    }
    const r1 = I.buildWindow(msgs, "ses_sticky", 4000)
    assert.ok(r1.stats.evictedCount >= 1)
    // looser cap on the same history: sticky floor must keep at least the previous evictions
    const r2 = I.buildWindow(msgs, "ses_sticky", 20000, undefined, undefined, undefined, undefined, r1.stats.evictedCount)
    assert.ok(r2.stats.evictedCount >= r1.stats.evictedCount, `sticky violated: ${r2.stats.evictedCount} < ${r1.stats.evictedCount}`)
    // written-guard: nothing archived yet (empty written set) → eviction must be blocked entirely
    const r3 = I.buildWindow(msgs, "ses_guard", 4000, undefined, undefined, new Set<string>())
    assert.equal(r3.stats.evictedCount, 0, "cannot evict units whose content is not in the raw file yet")
  })
})

// ================================================================ 12/25 resolveInMemfs (path sandbox)
describe("resolveInMemfs", () => {
  // NOTE: like the tool handlers, resolveInMemfs takes root = <worktree>/.hippocampus
  const mkRoot = (): string => {
    const wt = tmp()
    fs.mkdirSync(path.join(wt, ".hippocampus", "memfs"), { recursive: true })
    return path.join(wt, ".hippocampus")
  }
  it("relative paths resolve inside <root>/memfs/", async () => {
    const root = mkRoot()
    assert.equal(await I.resolveInMemfs(root, "notes/a.md"), path.join(root, "memfs", "notes", "a.md"))
  })
  it("absolute / drive-letter / backslash / NUL / .. all rejected (null)", async () => {
    const root = mkRoot()
    for (const bad of ["../x.md", "/etc/passwd", "C:\\evil.md", "a\\b.md", "bad\0name"]) {
      assert.equal(await I.resolveInMemfs(root, bad), null, `must reject: ${JSON.stringify(bad)}`)
    }
  })
  it("symlink escape out of memfs is rejected (realpath containment)", async () => {
    const root = mkRoot()
    const outside = tmp()
    fs.writeFileSync(path.join(outside, "secret.txt"), "top secret")
    fs.symlinkSync(outside, path.join(root, "memfs", "link"))
    assert.equal(await I.resolveInMemfs(root, "link/secret.txt"), null)
  })
})

// ================================================================ 13/25 memfsWrite (limits + validation)
describe("memfsWrite", () => {
  // NOTE: like the tool handlers, memfsWrite takes root = <worktree>/.hippocampus
  const mkRoot = (): string => {
    const wt = tmp()
    fs.mkdirSync(path.join(wt, ".hippocampus", "memfs"), { recursive: true })
    return path.join(wt, ".hippocampus")
  }
  it("valid write returns byte count and persists content", async () => {
    const root = mkRoot()
    const r = await I.memfsWrite(root, "a/b.md", "hello")
    assert.equal(r.bytes, 5)
    assert.equal(fs.readFileSync(path.join(root, "memfs", "a", "b.md"), "utf8"), "hello")
  })
  it("depth > 4 and hidden segments rejected; .. escape rejected by resolver", async () => {
    const wt2 = tmp()
    fs.mkdirSync(path.join(wt2, ".hippocampus", "memfs"), { recursive: true })
    const root = path.join(wt2, ".hippocampus")
    assert.match((await I.memfsWrite(root, "a/b/c/d/e/f.md", "x")).error ?? "", /depth > 4/)
    assert.match((await I.memfsWrite(root, ".secret.md", "x")).error ?? "", /hidden segments/)
    assert.match((await I.memfsWrite(root, "../escape.md", "x")).error ?? "", /invalid path/)
    // nothing may have been written outside .hippocampus/ (worktree root must stay clean except the dir itself)
    assert.deepEqual(fs.readdirSync(wt2), [".hippocampus"], `stray files at worktree root: ${fs.readdirSync(wt2)}`)
  })
  it("per-file and total byte limits enforced with exact error messages", async () => {
    const root = mkRoot()
    assert.equal((await I.memfsWrite(root, "big.md", "x".repeat(11), { maxFileBytes: 10 })).error, "file too large (11 bytes, max 10)")
    fs.writeFileSync(path.join(root, "memfs", "a.md"), "abcde") // pre-existing 5 B
    const r = await I.memfsWrite(root, "c/d.md", "abcdef", { maxTotalBytes: 6 })
    assert.match(r.error ?? "", /memfs would exceed total limit \(11 bytes, max 6\)/)
  })
})

// ================================================================ 14/25 recallAppend (JSONL history log)
describe("recallAppend", () => {
  it("appends JSON line with timestamp + sanitized session name + entry fields", async () => {
    const wt = mkWorktree()
    await I.recallAppend(wt, "ses_abc", { role: "user", text: "hello world" })
    const f = path.join(wt, ".hippocampus", "recall", "ses_abc.jsonl")
    assert.ok(fs.existsSync(f))
    const line = JSON.parse(fs.readFileSync(f, "utf8").trim())
    assert.equal(line.s, "ses_abc")
    assert.equal(line.role, "user")
    assert.equal(line.text, "hello world")
    assert.match(line.t, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })
  it("secrets in entry fields are redacted before storage", async () => {
    const wt = mkWorktree()
    await I.recallAppend(wt, "ses_red", { text: "token sk-abcdefghij12345678 end" })
    const raw = fs.readFileSync(path.join(wt, ".hippocampus", "recall", "ses_red.jsonl"), "utf8")
    assert.ok(raw.includes("[REDACTED]"))
    assert.ok(!raw.includes("sk-abcdefghij12345678"))
  })
  it("hostile session ids are sanitized: file stays inside recall/", async () => {
    const wt = mkWorktree()
    await I.recallAppend(wt, "ses/../../etc/passwd", { text: "x" })
    const files = fs.readdirSync(path.join(wt, ".hippocampus", "recall"))
    assert.ok(files.length === 1 && /^[A-Za-z0-9_-]+\.jsonl$/.test(files[0]), `unexpected file name: ${files}`)
    assert.ok(!fs.existsSync("/etc/passwd.jsonl"))
  })
})

// ================================================================ 15/25 recallSearch (substring search over history)
describe("recallSearch", () => {
  it("case-insensitive substring across text/output/args fields, [file:line] format", async () => {
    const wt = mkWorktree()
    await I.recallAppend(wt, "s1", { role: "user", text: "Alpha beta" })
    await I.recallAppend(wt, "s1", { tool: "bash", output: "gamma delta line" })
    const r = await I.recallSearch(wt, "GAMMA", 10) // uppercase query vs lowercase stored
    assert.equal(r.count, 1)
    assert.ok(r.matches.includes("[s1.jsonl:"), r.matches)
    assert.ok(r.matches.includes("gamma delta line"))
  })
  it("limit keeps the LAST N matches; count reports total hits", async () => {
    const wt = mkWorktree()
    for (let i = 1; i <= 15; i++) await I.recallAppend(wt, "s2", { text: `needle ${i}` })
    const r = await I.recallSearch(wt, "needle", 10)
    assert.equal(r.count, 15)
    const lines = r.matches.split("\n")
    assert.equal(lines.length, 10, `expected exactly 10 kept matches, got ${lines.length}`)
    assert.ok(lines[9].includes("needle 15"), "most recent hit must be last: " + lines[9])
    assert.ok(!r.matches.includes("needle 1\n") && !r.matches.includes("[s2.jsonl:1] "), "oldest hits must have been dropped")
  })
  it("no history → 'no recall history yet'; no matches → 'no matches'", async () => {
    const wt = mkWorktree()
    assert.deepEqual(await I.recallSearch(wt, "anything", 5), { matches: "no recall history yet", count: 0 })
    await I.recallAppend(wt, "s3", { text: "only content" })
    const r = await I.recallSearch(wt, "zzz-not-there", 5)
    assert.equal(r.matches, "no matches")
    assert.equal(r.count, 0)
  })
})

// ================================================================ 16/25 atomicWrite (tmp+rename)
describe("atomicWrite", () => {
  it("writes exact bytes (unicode/newlines) and leaves no .tmp residue", async () => {
    const dir = tmp()
    await I.atomicWrite(path.join(dir, "f.txt"), "line1\nлиния2\nemoji 🚀\n")
    assert.equal(fs.readFileSync(path.join(dir, "f.txt"), "utf8"), "line1\nлиния2\nemoji 🚀\n")
    assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith(".tmp")))
  })
  it("overwrites in place (rename replaces), no stale bytes remain", async () => {
    const dir = tmp()
    const f = path.join(dir, "g.txt")
    await I.atomicWrite(f, "x".repeat(100))
    await I.atomicWrite(f, "short")
    assert.equal(fs.readFileSync(f, "utf8"), "short")
  })
  it("failed rename cleans up the tmp file and rethrows", async () => {
    const dir = tmp()
    fs.mkdirSync(path.join(dir, "f")) // target path is a directory → rename must fail
    await assert.rejects(() => I.atomicWrite(path.join(dir, "f"), "data"))
    assert.ok(!fs.readdirSync(dir).some((x) => x.endsWith(".tmp")), "tmp file must be cleaned up after failure")
  })
})

// ================================================================ 17/25 isSafeWorktree (root guard)
describe("isSafeWorktree", () => {
  it("home directory and filesystem root are unsafe", () => {
    assert.equal(I.isSafeWorktree(os.homedir()), false)
    assert.equal(I.isSafeWorktree(path.parse(os.homedir()).root), false) // "/" on linux
  })
  it("a normal project directory is safe", () => {
    assert.equal(I.isSafeWorktree(tmp()), true)
  })
  it("relative paths resolve against cwd (safe when cwd is a project)", () => {
    assert.equal(I.isSafeWorktree("sub/dir"), true) // repo root cwd ≠ homedir/root
  })
})

// ================================================================ 18/25 ensureInit (bootstrap)
describe("ensureInit", () => {
  it("creates all hippocampus dirs + default core-memory.md with PERSONA/HUMAN blocks", async () => {
    const wt = tmp()
    await I.ensureInit(wt)
    for (const d of ["memfs", "recall", "raw", "checkpoints", "wiki"]) {
      assert.ok(fs.existsSync(path.join(wt, ".hippocampus", d)), `missing dir ${d}`)
    }
    const cm = fs.readFileSync(path.join(wt, ".hippocampus", "core-memory.md"), "utf8")
    assert.ok(cm.includes("## PERSONA"))
    assert.ok(cm.includes("## HUMAN"))
  })
  it("idempotent and never overwrites an existing core-memory.md", async () => {
    const wt = tmp()
    fs.mkdirSync(path.join(wt, ".hippocampus"), { recursive: true })
    fs.writeFileSync(path.join(wt, ".hippocampus", "core-memory.md"), "## CUSTOM\nmy own content\n")
    await I.ensureInit(wt)
    await I.ensureInit(wt) // second call must be a no-op
    assert.equal(fs.readFileSync(path.join(wt, ".hippocampus", "core-memory.md"), "utf8"), "## CUSTOM\nmy own content\n")
  })
  it("appends hippocampus gitignore lines once, preserving existing .gitignore", async () => {
    const wt = tmp()
    fs.writeFileSync(path.join(wt, ".gitignore"), "node_modules/\n")
    await I.ensureInit(wt)
    let gi = fs.readFileSync(path.join(wt, ".gitignore"), "utf8")
    assert.ok(gi.includes("node_modules/"), "existing lines must be preserved")
    assert.ok(gi.includes(".hippocampus/raw/") && gi.includes(".hippocampus/hippocampus.json"))
    await I.ensureInit(wt)
    gi = fs.readFileSync(path.join(wt, ".gitignore"), "utf8")
    const n = gi.split("\n").filter((l) => l.trim() === ".hippocampus/raw/").length
    assert.equal(n, 1, "no duplicate gitignore lines on re-init")
  })
})

// ================================================================ 19/25 v2ToLegacy (wire → internal adapter)
describe("v2ToLegacy", () => {
  it("system messages dropped; text parts mapped with stable ids", () => {
    const out = I.v2ToLegacy([
      { role: "system", content: [{ type: "text", text: "sys" }] },
      { id: "m1", role: "user", content: [{ type: "text", text: "hi" }] },
    ])
    assert.equal(out.length, 1)
    assert.equal(out[0].info.role, "user")
    assert.equal(out[0].parts[0].text, "hi")
  })
  it("tool-call + later tool-result are paired into one legacy message (output attached)", () => {
    const out = I.v2ToLegacy([
      { id: "a1", role: "assistant", content: [{ type: "tool-call", id: "c1", name: "bash", input: { cmd: "ls" } }] },
      { id: "r1", role: "assistant", content: [{ type: "tool-result", id: "c1", name: "bash", result: { type: "content", value: [{ type: "text", text: "OUT" }] } }] },
    ])
    assert.equal(out.length, 1, `result message must not create a second legacy message, got ${out.length}`)
    const toolPart = out[0].parts.find((p: any) => p.type === "tool")
    assert.ok(toolPart, "tool part missing")
    assert.equal(toolPart.callID, "c1")
    assert.equal(toolPart.state.output, "OUT")
  })
  it("media base64 → data-URL file part; compaction → '[provider compaction]' text", () => {
    const out = I.v2ToLegacy([
      { id: "m2", role: "user", content: [{ type: "media", filename: "a.png", media: { source: { type: "base64", data: "aGVsbG8=", mediaType: "image/png" } } }] },
      { id: "m3", role: "assistant", content: [{ type: "compaction", text: "summary here" }] },
    ])
    assert.equal(out[0].parts[0].type, "file")
    assert.equal(out[0].parts[0].url, "data:image/png;base64,aGVsbG8=")
    assert.ok(out[1].parts[0].text.startsWith("[provider compaction]\nsummary here"))
  })
  it("media url-source: top-level media.mediaType wins over source (regression: core crashes on undefined mime)", () => {
    const out = I.v2ToLegacy([
      { id: "m1", role: "user", content: [{ type: "media", filename: "a.png", media: { mediaType: "image/png", source: { type: "url", url: "/tmp/a.png" } } }] },
    ])
    assert.equal(out[0].parts[0].type, "file")
    assert.equal(out[0].parts[0].mime, "image/png")
    assert.equal(out[0].parts[0].url, "/tmp/a.png")
  })
})

// ================================================================ 20/25 legacyToV2 (internal → wire adapter)
describe("legacyToV2", () => {
  it("user text round-trips with id and role preserved", () => {
    const out = I.legacyToV2([{ info: { id: "m1", role: "user" }, parts: [{ id: "p", type: "text", text: "hi" }] }])
    assert.deepEqual(out, [{ id: "m1", role: "user", content: [{ type: "text", text: "hi" }] }])
  })
  it("tool part → tool-call in assistant message + separate role:'tool' result message", () => {
    const out = I.legacyToV2([{ info: { id: "a1", role: "assistant" }, parts: [{ id: "p", type: "tool", tool: "bash", callID: "c1", state: { input: { a: 1 }, output: "OUT" } }] }])
    assert.equal(out.length, 2)
    const call = out[0].content.find((c: any) => c.type === "tool-call")
    assert.deepEqual(call, { type: "tool-call", id: "c1", name: "bash", input: { a: 1 } })
    assert.equal(out[1].role, "tool")
    const res = out[1].content[0]
    assert.equal(res.type, "tool-result")
    assert.deepEqual(res.result, { type: "content", value: [{ type: "text", text: "OUT" }] })
  })
  it("step-start/step-finish dropped; data-URL file → media base64 part", () => {
    const out = I.legacyToV2([{ info: { id: "m1", role: "assistant" }, parts: [
      { id: "s1", type: "step-start" },
      { id: "f1", type: "file", url: "data:image/png;base64,aGVsbG8=", mime: "image/png", filename: "a.png" },
      { id: "t1", type: "text", text: "x" },
    ] }])
    assert.equal(out.length, 1)
    const types = out[0].content.map((c: any) => c.type)
    assert.deepEqual(types, ["media", "text"])
    assert.equal(out[0].content[0].media.source.type, "base64")
    assert.equal(out[0].content[0].media.source.data, "aGVsbG8=")
  })
  it("url file part → media with media.mediaType always set (regression: core 'H.startsWith' crash on undefined mime)", () => {
    const out = I.legacyToV2([{ info: { id: "m1", role: "user" }, parts: [
      { id: "f1", type: "file", url: "/tmp/a.png", mime: "image/png", filename: "a.png" },
      { id: "f2", type: "file", url: "/tmp/b.bin", filename: "b.bin" },
    ] }])
    assert.equal(out.length, 1)
    const [m1, m2] = out[0].content
    assert.equal(m1.type, "media")
    assert.equal(m1.media.source.type, "url")
    assert.equal(m1.media.mediaType, "image/png")
    // no mime known → must still emit a defined type (octet-stream), never undefined
    assert.equal(m2.media.mediaType, "application/octet-stream")
  })
  it("media part round-trips as the SAME object (regression: core 'Schema validation failed' — Media.Asset instanceof)", () => {
    // Simulate core's internal Media.Asset class instance living on the V2 wire part.
    class FakeAsset {}
    const mediaObj = Object.assign({ source: { type: "base64", data: "aGVsbG8=", mediaType: "image/png" }, mediaType: "image/png" }, new FakeAsset())
    const v2part = { type: "media", filename: "a.png", media: mediaObj }
    const legacy = I.v2ToLegacy([{ id: "m1", role: "user", content: [v2part] }])
    assert.equal(legacy[0].parts[0].type, "file")
    const out = I.legacyToV2(legacy)
    // Must be the exact same part object (and thus the same media instance), not a re-serialized plain copy.
    assert.strictEqual(out[0].content[0], v2part, "media part must round-trip by reference to keep Media.Asset instanceof")
  })
})

// ================================================================ 21/25 contextLookup (archive read-back)
describe("contextLookup", () => {
  const wt = mkWorktree()
  fs.mkdirSync(path.join(wt, ".hippocampus", "raw"), { recursive: true })
  fs.writeFileSync(
    path.join(wt, ".hippocampus", "raw", "ses_test.md"),
    [
      "# session ses_test · /tmp/x · started 2026-01-01T00:00:00Z",
      "",
      '## u_u1 · 10:00:00 · user→assistant×1 · ~5 tok · "first question"',
      "<!-- m_m1 -->",
      "[user]",
      "hello there",
      "\\## u_fake (escaped line inside content)",
      "",
      "### t_c1 · bash · (~3 tok)",
      "line one of output",
      "line two of output",
      "",
      '## u_u2 · 10:05:00 · user→assistant×1 · ~4 tok · "second question"',
      "<!-- m_m2 -->",
      "[user]",
      "bye now",
    ].join("\n"),
  )
  it("no target → table of contents with all segment headers", async () => {
    const s = await I.contextLookup(wt, undefined, undefined, 65536)
    assert.ok(s.includes("# ses_test.md — table of contents"))
    assert.ok(s.includes("2 segment(s):"))
    assert.ok(s.includes('## u_u1 · 10:00:00') && s.includes('## u_u2 · 10:05:00'))
  })
  it("u_<id> returns the whole segment (escaped structural lines included, next segment excluded); t_<id> returns one tool block", async () => {
    const seg = await I.contextLookup(wt, "ses_test.md", "u_u1", 65536)
    assert.ok(seg.includes("## u_fake (escaped line inside content)"), "escaped line must be restored to its original text on read-back")
    assert.ok(!seg.includes("\\## u_fake"), "escape prefix must not leak into the output")
    assert.ok(seg.includes("line two of output"))
    assert.ok(!seg.includes("bye now"), "next segment content must not leak in")
    const blk = await I.contextLookup(wt, "ses_test.md", "t_c1", 65536)
    assert.ok(blk.startsWith("### t_c1 · bash"))
    assert.ok(blk.includes("line one of output") && blk.includes("line two of output"))
    assert.ok(!blk.includes("## u_u2"))
  })
  it("invalid targets and ranges produce precise errors; ':a-b' slices the block", async () => {
    assert.match(await I.contextLookup(wt, "ses_test.md", "x_bad", 65536), /target must be/)
    assert.match(await I.contextLookup(wt, "ses_test.md", "u_u1:5-2", 65536), /invalid line range/)
    assert.match(await I.contextLookup(wt, "ses_test.md", "u_missing", 65536), /not found in ses_test\.md/)
    const sliced = await I.contextLookup(wt, "ses_test.md", "u_u1:2-4", 65536)
    assert.ok(sliced.startsWith("[lines 2-4 of "), sliced.slice(0, 40))
    assert.ok(!sliced.includes("### t_c1"), "slice must not run past the requested range")
  })
})

// ================================================================ 22/25 resolveContextFile (archive path sandbox)
describe("resolveContextFile", () => {
  const wt = mkWorktree()
  fs.mkdirSync(path.join(wt, ".hippocampus", "raw"), { recursive: true })
  fs.writeFileSync(path.join(wt, ".hippocampus", "raw", "ses_test.md"), "# x\n")
  it("plain and prefixed relative .md names resolve inside raw/", async () => {
    const abs = path.join(wt, ".hippocampus", "raw", "ses_test.md")
    assert.equal(await I.resolveContextFile(wt, "ses_test.md"), abs)
    assert.equal(await I.resolveContextFile(wt, ".hippocampus/raw/ses_test.md"), abs) // prefix stripped
  })
  it("traversal / absolute / drive / backslash / non-.md all rejected", async () => {
    for (const bad of ["../evil.md", "/etc/passwd", "C:\\x.md", "a\\b.md", "notes.txt"]) {
      assert.equal(await I.resolveContextFile(wt, bad), null, `must reject: ${JSON.stringify(bad)}`)
    }
  })
  it("no file arg → most recently modified .md; no raw dir → null", async () => {
    const old = path.join(wt, ".hippocampus", "raw", "old.md")
    fs.writeFileSync(old, "# old\n")
    const past = new Date(Date.now() - 3600_000)
    fs.utimesSync(old, past, past)
    await new Promise((r) => setTimeout(r, 20)) // ensure distinct mtime
    const fresh = path.join(wt, ".hippocampus", "raw", "fresh.md")
    fs.writeFileSync(fresh, "# fresh\n")
    assert.equal(await I.resolveContextFile(wt, undefined), fresh)
    const empty = mkWorktree()
    assert.equal(await I.resolveContextFile(empty, undefined), null)
  })
})

// ================================================================ 23/25 parseFrontmatter / serializePage (wiki pages)
describe("parseFrontmatter + serializePage", () => {
  it("round-trip: all standard keys and body survive serialization", () => {
    const fm = { title: "Build SOP", type: "skill", description: "How to build", sources: "ses_1,ses_2", "source-session": "ses_1", valid_from: "2026-01-01" }
    const text = I.serializePage(fm, "run the tests")
    const back = I.parseFrontmatter(text)
    assert.deepEqual(back.fm, fm)
    assert.equal(back.body, "run the tests\n") // serializePage appends a trailing blank line; parse keeps it
  })
  it("unclosed frontmatter block → treated as plain body (fm empty)", () => {
    const text = "---\ntitle: X\nbody without closing fence"
    const r = I.parseFrontmatter(text)
    assert.deepEqual(r.fm, {})
    assert.equal(r.body, text)
  })
  it("extra keys preserved through serialize; quoted values unquoted on parse", () => {
    const text = I.serializePage({ title: "T", status: "proposed" }, "b")
    assert.ok(text.includes("status: proposed"), "non-standard key must survive: " + text)
    const r = I.parseFrontmatter('---\ntitle: "Quoted Title"\n---\nbody')
    assert.equal(r.fm.title, "Quoted Title")
  })
})

// ================================================================ 24/25 wikiSearch / rebuildWikiIndex (FTS5 + fallback)
describe("wikiSearch + rebuildWikiIndex", () => {
  const mkRoot = (): string => {
    const root = tmp()
    fs.mkdirSync(path.join(root, "wiki", "concepts"), { recursive: true })
    fs.mkdirSync(path.join(root, "wiki", "skills"), { recursive: true })
    fs.writeFileSync(
      path.join(root, "wiki", "concepts", "build.md"),
      "---\ntitle: Build SOP\ntype: skill\ndescription: How to build the project correctly\n---\n\nrun npm test then deploy [[Deploy Runbook]]\n",
    )
    fs.writeFileSync(
      path.join(root, "wiki", "skills", "deploy.md"),
      "---\ntitle: Deploy Runbook\ntype: sop\ndescription: Deployment steps\n---\n\nssh in and deploy\n",
    )
    return root
  }
  it("rebuild indexes all pages; search returns ranked hits + 1-hop [[link]] expansion", async () => {
    const root = mkRoot()
    assert.equal(await I.rebuildWikiIndex(root), 2)
    const s = await I.wikiSearch(root, "build", 8)
    assert.ok(s.includes("concepts/build.md"), s)
    assert.ok(s.includes('"Build SOP"'))
    assert.ok(s.includes("Related (1-hop): skills/deploy.md — \"Deploy Runbook\""), `link expansion missing: ${s}`)
  })
  it("FTS injection payloads are neutralized (quoted terms, parameterized query), no throw", async () => {
    const root = mkRoot()
    await I.rebuildWikiIndex(root)
    for (const q of ['"; DROP TABLE pages;--', '" OR ""="', 'AND NOT 1=1']) {
      let out: string
      await assert.doesNotReject(() => I.wikiSearch(root, q, 8), `query threw: ${q}`)
      out = await I.wikiSearch(root, q, 8)
      assert.equal(typeof out, "string")
    }
    // the pages table must still be intact and queryable after injection attempts
    const s = await I.wikiSearch(root, "deploy", 8)
    assert.ok(s.includes("skills/deploy.md"), `index damaged: ${s}`)
  })
  it("empty wiki → friendly message; pure-symbol query → 'empty query'", async () => {
    const empty = tmp()
    assert.equal(await I.wikiSearch(empty, "anything", 8), "(wiki is empty — create pages with hippo_wiki_write)")
    const root = mkRoot()
    assert.equal(await I.wikiSearch(root, '"""', 8), "empty query")
  })
})

// ================================================================ date-filtered search (recorded_at / entry timestamp)
describe("date filters: wiki recorded_at + recall timestamps", () => {
  const mkDatedRoot = (): string => {
    const root = tmp()
    fs.mkdirSync(path.join(root, "wiki", "concepts"), { recursive: true })
    fs.writeFileSync(
      path.join(root, "wiki", "concepts", "build.md"),
      "---\ntitle: Build SOP\ntype: skill\ndescription: How to build the project correctly\nrecorded_at: 2026-10-01T10:00:00Z\n---\n\nrun npm test then deploy [[Deploy Runbook]]\n",
    )
    fs.writeFileSync(
      path.join(root, "wiki", "concepts", "deploy.md"),
      "---\ntitle: Deploy Runbook\ntype: skill\ndescription: Deployment steps\nrecorded_at: 2026-11-05T08:30:00Z\n---\n\nssh in and deploy the build\n",
    )
    // legacy page without a stamp: searchable, but never matches a date filter
    fs.writeFileSync(
      path.join(root, "wiki", "concepts", "legacy.md"),
      "---\ntitle: Legacy Notes\ntype: concept\ndescription: Old notes about deploy\n---\n\ndeploy was manual before\n",
    )
    return root
  }
  const hitPaths = (s: string): string[] => s.split("\n").filter((l) => /^\d+\. /.test(l)).map((l) => l.replace(/^\d+\. /, "").split(" — ")[0])

  it("no filter → all pages; date_to cuts the newer page out of hits", async () => {
    const root = mkDatedRoot()
    await I.rebuildWikiIndex(root)
    const s = await I.wikiSearch(root, "deploy", 8)
    assert.deepEqual(hitPaths(s).sort(), ["concepts/build.md", "concepts/deploy.md", "concepts/legacy.md"], s)

    const old = await I.wikiSearch(root, "deploy", 8, undefined, "2026-10-31")
    // only build.md (2026-10-01) is in range; deploy.md may still appear as a 1-hop related link, not as a hit
    assert.deepEqual(hitPaths(old), ["concepts/build.md"], old)

    const win = await I.wikiSearch(root, "deploy", 8, "2026-11-01", "2026-11-30")
    assert.deepEqual(hitPaths(win), ["concepts/deploy.md"], win)
  })

  it("unstamped (legacy) pages never match a date filter; bare day in date_to is inclusive to end-of-day", async () => {
    const root = mkDatedRoot()
    await I.rebuildWikiIndex(root)
    const old = await I.wikiSearch(root, "deploy", 8, undefined, "2026-10-31")
    assert.ok(!hitPaths(old).includes("concepts/legacy.md"), old)

    // deploy.md stamped 2026-11-05T08:30 → a bare date_to of the same day must include it (expanded to 23:59:59)
    const sameDay = await I.wikiSearch(root, "deploy", 8, undefined, "2026-11-05")
    assert.ok(hitPaths(sameDay).includes("concepts/deploy.md"), sameDay)
    const prevDay = await I.wikiSearch(root, "deploy", 8, undefined, "2026-11-04")
    assert.ok(!hitPaths(prevDay).includes("concepts/deploy.md"), prevDay)
  })

  it("invalid bounds → friendly error, no throw", async () => {
    const root = mkDatedRoot()
    await I.rebuildWikiIndex(root)
    assert.match(await I.wikiSearch(root, "deploy", 8, "banana"), /invalid date_from/)
    assert.match(await I.wikiSearch(root, "deploy", 8, undefined, "31/12/2026"), /invalid date_to/)
  })

  it("stampRecordedAt: inserts ISO stamp when missing, keeps explicit value, no-op without frontmatter", () => {
    const c = "---\ntitle: T\ntype: concept\n---\nbody"
    const stamped = I.stampRecordedAt(c)
    assert.match(stamped, /^recorded_at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m)
    assert.ok(stamped.startsWith("---\ntitle: T\ntype: concept\n"), stamped)

    const explicit = "---\ntitle: T\nrecorded_at: 2026-01-01T00:00:00Z\n---\nbody"
    assert.equal(I.stampRecordedAt(explicit), explicit)
    assert.equal(I.stampRecordedAt("plain body"), "plain body")
  })

  it("normalizeDateBound: bare day expands per bound, ISO canonicalized to stored shape, junk → null", () => {
    // wiki shape (no millis): bare day → start / end of day in UTC
    assert.equal(I.normalizeDateBound("2026-11-01", false), "2026-11-01T00:00:00Z")
    assert.equal(I.normalizeDateBound("2026-11-01", true), "2026-11-01T23:59:59Z")
    // ISO passthrough (millis stripped to the wiki stamp shape)
    assert.equal(I.normalizeDateBound("2026-11-01T08:30:00.456Z", false), "2026-11-01T08:30:00Z")
    // zoneless datetime treated as UTC; offsets converted to UTC
    assert.equal(I.normalizeDateBound("2026-11-01T08:30", false), "2026-11-01T08:30:00Z")
    assert.equal(I.normalizeDateBound("2026-11-01T10:30:00+02:00", false), "2026-11-01T08:30:00Z")
    // recall shape (millis): bare day → .000 / .999, toISOString input passes through
    assert.equal(I.normalizeDateBound("2026-11-01", true, true), "2026-11-01T23:59:59.999Z")
    assert.equal(I.normalizeDateBound("2026-11-01T08:30:45.123Z", false, true), "2026-11-01T08:30:45.123Z")
    // junk → null (no throw)
    assert.equal(I.normalizeDateBound("banana", true), null)
    assert.equal(I.normalizeDateBound("", false), null)
    assert.equal(I.normalizeDateBound("2026-13-99T99:99", false), null)
  })

  it("recallSearch date_from/date_to filter entries by timestamp; invalid bound → error", async () => {
    const wt = mkWorktree()
    await I.recallAppend(wt, "s4", { text: "temporal marker entry" })
    // wide window around now → match
    const r1 = await I.recallSearch(wt, "temporal marker", 5, "2026-01-01", new Date(Date.now() + 36e5).toISOString())
    assert.equal(r1.count, 1)
    // past-only window → nothing (entries carry the real current timestamp)
    const r2 = await I.recallSearch(wt, "temporal marker", 5, "2025-01-01", "2025-12-31")
    assert.equal(r2.count, 0)
    assert.equal(r2.matches, "no matches")
    // invalid bound → error message instead of a crash
    assert.match((await I.recallSearch(wt, "temporal marker", 5, "banana")).matches, /invalid date_from/)
  })
})

// ================================================================ 25/25 putCapture / capturesBySession / deleteSessionState
describe("capture store (lossless tool outputs)", () => {
  it("putCapture stores full output retrievable by callID", () => {
    I.putCapture("s_cap", "c1", "x".repeat(100), 1048576)
    const s = I.capturesBySession.get("s_cap")
    assert.ok(s, "session store missing")
    assert.equal(s.m.get("c1"), "x".repeat(100))
    assert.equal(s.bytes, 100)
  })
  it("oversized output truncated to maxBytes; FIFO eviction when over budget", () => {
    I.putCapture("s_trunc", "c9", "y".repeat(200), 50)
    assert.equal(I.capturesBySession.get("s_trunc").m.get("c9").length, 50)
    I.putCapture("s_evict", "c1", "a".repeat(40), 50)
    I.putCapture("s_evict", "c2", "b".repeat(40), 50) // 80 > 50 → evicts c1
    I.putCapture("s_evict", "c3", "c".repeat(40), 50) // evicts c2
    const s = I.capturesBySession.get("s_evict")
    assert.equal(s.m.size, 1)
    assert.ok(s.m.has("c3"), `expected only newest capture to survive, got ${[...s.m.keys()]}`)
    assert.ok(!s.m.has("c1") && !s.m.has("c2"))
  })
  it("deleteSessionState clears the session's captures (and log state)", () => {
    I.putCapture("s_del", "c1", "data", 1048576)
    assert.ok(I.capturesBySession.get("s_del"))
    I.deleteSessionState(tmp(), "s_del")
    assert.equal(I.capturesBySession.get("s_del"), undefined)
  })
})

// ================================================================ audit round 2026-10-23 (HIGH/MED fixes)
describe("audit-2026-10-23: media counted in unitSize", () => {
  it("a big base64 image pushes its unit over the cap and gets evicted", () => {
    // ~8 MB of base64 → ~6 MB decoded → estTokens ≈ ceil((len*3/4)/8) ≈ 900k tokens, far above any cap.
    const b64 = "A".repeat(8 * 1024 * 1024)
    const msgs: any[] = [
      U("u1", "alpha question"),
      { info: { id: "u2", role: "user" }, parts: [{ id: "f1", type: "file", mime: "image/png", url: `data:image/png;base64,${b64}`, filename: "big.png" }] },
      U("u3", "tail question"),
    ]
    const r = I.buildWindow(msgs, "ses_media_big", 8000) // cap = floor(8000*capRatio) ≈ 1600 tokens
    assert.ok(r.stats.evictedCount >= 1, `media unit must be evicted, got stats=${JSON.stringify(r.stats)}`)
    const dataUrls = r.messages.flatMap((m: any) => m.parts.filter((p: any) => p.type === "file" && String(p.url ?? "").startsWith("data:")))
    assert.equal(dataUrls.length, 0, "no base64 data URL may survive in the window")
  })
  it("a tiny image stays under the cap and is kept verbatim", () => {
    const b64 = Buffer.from([1, 2, 3]).toString("base64") // ~1 token
    const msgs: any[] = [U("u1", "hi"), { info: { id: "u2", role: "user" }, parts: [{ id: "f1", type: "file", mime: "image/png", url: `data:image/png;base64,${b64}`, filename: "s.png" }] }]
    const r = I.buildWindow(msgs, "ses_media_small", 64000) // cap ≈ 12800 — plenty for a few tokens of media
    assert.equal(r.stats.evictedCount, 0, `tiny media must not be evicted: ${JSON.stringify(r.stats)}`)
    const kept = r.messages.flatMap((m: any) => m.parts).find((p: any) => p.type === "file")
    assert.ok(kept && String(kept.url).startsWith("data:image/png"), "the file part must survive in the window")
  })
})

describe("audit-2026-10-23: wiki index freshness", () => {
  it("in-place body edit (same page count) is visible to FTS on next search", async () => {
    const wt = mkWorktree()
    await I.ensureInit(wt)
    const root = I.hippoRoot(wt)
    const wikiDir = path.join(root, "wiki")
    fs.mkdirSync(path.join(wikiDir, "concepts"), { recursive: true })
    const pagePath = path.join(wikiDir, "concepts", "fresh.md")
    let body = "---\ntitle: Fresh\ntype: concept\ndescription: d\n---\noriginal content here\n"
    fs.writeFileSync(pagePath, body)

    const first = await I.wikiSearch(root, "original", 5)
    assert.ok(first.includes("concepts/fresh.md"), `first search must hit: ${first}`)
    assert.ok(first.includes("…"), "FTS path expected (snippet line present)")

    // In-place edit: page count unchanged; a stale index would never see the new word via FTS.
    fs.writeFileSync(pagePath, body.replace("original content here", "brandnewkeyword zzzqqq content"))
    const future = new Date(Date.now() + 5000) // guarantee mtime strictly increases (coarse clocks)
    fs.utimesSync(pagePath, future, future)

    const second = await I.wikiSearch(root, "brandnewkeyword", 5)
    assert.ok(second.includes("concepts/fresh.md"), `in-place edit must be found: ${second}`)
    assert.ok(second.includes("…"), `hit must come from the refreshed FTS index (snippet), not substring fallback: ${second}`)
  })
})

describe("audit-2026-10-23: attachmentHash consistency", () => {
  const sha = (s: Buffer | string): string => createHash("sha256").update(s).digest("hex").slice(0, 16)
  it("base64 data URL hashes the decoded bytes (same digest as the stored file)", () => {
    const payload = "Hello, мир"
    const b64 = Buffer.from(payload).toString("base64")
    assert.equal(I.attachmentHash(`data:text/plain;base64,${b64}`), sha(Buffer.from(payload)))
  })
  it("plain data URL hashes the percent-decoded payload", () => {
    assert.equal(I.attachmentHash("data:text/plain,hi%20there"), sha(Buffer.from("hi there")))
  })
  it("non-data URLs return empty string (never archived)", () => {
    assert.equal(I.attachmentHash(""), "")
    assert.equal(I.attachmentHash("https://example.com/x.png"), "")
  })
})

describe("audit-2026-10-23: unarchivable attachments warn once", () => {
  it("oversized attachment → exactly one 'NOT archived' log line across repeated context calls", async () => {
    const wt = mkWorktree()
    // trace logging so the attach warnings land in the file (applyLogLevel is what setup() does from config)
    I.applyLogLevel(wt, "trace")
    await I.ensureInit(wt)
    const b64 = "A".repeat(12 * 1024 * 1024) // decodes ~9 MB > default maxAttachmentBytes (8 MB)
    const msg: any = { info: { id: "u_ov", role: "user" }, parts: [{ id: "f_ov", type: "file", mime: "image/png", url: `data:image/png;base64,${b64}` }] }
    for (let i = 0; i < 3; i++) await I.archiveUserMedia([msg], wt) // simulates three context hook calls

    const logsDir = path.join(wt, ".hippocampus", "logs")
    const files = fs.readdirSync(logsDir).filter((f: string) => f.endsWith(".log"))
    let warns = 0
    for (const f of files) warns += (fs.readFileSync(path.join(logsDir, f), "utf8").match(/NOT archived/g) ?? []).length
    assert.equal(warns, 1, `expected exactly one warn line, got ${warns}`)
    const attDir = path.join(wt, ".hippocampus", "attachments") // dir exists (ensureInit), but must be empty
    assert.deepEqual(fs.existsSync(attDir) ? fs.readdirSync(attDir) : [], [], "no attachment file may be written")
  })
})

// ================================================================ stage-1 audit (2026-11): redact / paths / dedup / links / walk cap
describe("stage-1: redactSecrets secret_key/api_token/private_key variants", () => {
  it("env-style, quoted and =-assigned forms are all redacted; Bearer/JWT keep working", () => {
    const s = I.redactSecrets('export SECRET_KEY=abcdef1234567890\n"private_key": "pk-abcdefghijklmnop"\napi_token="tok_abcdefghij12345678"')
    assert.ok(!/abcdef1234567890/.test(s), `SECRET_KEY value leaked: ${s}`)
    assert.ok(!/pk-abcdefghijklmnop/.test(s), `private_key value leaked: ${s}`)
    assert.ok(!/tok_abcdefghij12345678/.test(s), `api_token value leaked: ${s}`)
    // regression guard for the pre-existing patterns that must keep working
    const r = I.redactSecrets("Authorization: Bearer abcdefghijklmnop1234\njwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
    assert.ok(r.includes("Bearer [REDACTED]") && !/abcdefghijklmnop1234/.test(r), `Bearer broken: ${r}`)
    assert.ok(!/eyJhbGciOiJIUzI1NiJ9/.test(r), `JWT broken: ${r}`)
  })
})

describe("stage-1: backslash paths rejected on all platforms", () => {
  it("resolveInWiki rejects backslashes / absolute / non-.md like the memfs and context resolvers", async () => {
    const wt = mkWorktree()
    fs.mkdirSync(path.join(wt, ".hippocampus", "wiki"), { recursive: true })
    const root = path.join(wt, ".hippocampus")
    for (const bad of ["a\\b.md", "..\\evil.md", "/etc/passwd.md", "C:\\x.md", "notes.txt"]) {
      assert.equal(await I.resolveInWiki(root, bad), null, `must reject: ${JSON.stringify(bad)}`)
    }
    fs.writeFileSync(path.join(wt, ".hippocampus", "wiki", "ok.md"), "# x")
    assert.equal(await I.resolveInWiki(root, "ok.md"), path.join(wt, ".hippocampus", "wiki", "ok.md"))
  })
})

describe("stage-1: normalizeForDedup canonical form", () => {
  it("case, punctuation and whitespace runs collapse identically (wikilinks unwrapped)", () => {
    assert.equal(I.normalizeForDedup("Hello,   World!! [[My Page]]"), "hello world my page")
    assert.equal(I.normalizeForDedup("HELLO - world?  MY_PAGE"), I.normalizeForDedup("hello world my page"))
  })
})

describe("stage-1: wikilink .md resolution", () => {
  it("[[page]], [[dir/page]] and [[dir/page.md]] all resolve; alias syntax works, unknown targets stay null", () => {
    const idx = I.buildLinkIndex([{ path: "dir/page.md", title: "Page Title" } as any])
    assert.equal(I.resolveLinkInIndex(idx, "page"), "dir/page.md")
    assert.equal(I.resolveLinkInIndex(idx, "dir/page"), "dir/page.md")
    assert.equal(I.resolveLinkInIndex(idx, "dir/page.md"), "dir/page.md") // trailing .md stripped explicitly
    assert.equal(I.resolveLinkInIndex(idx, "Page Title"), "dir/page.md")
    assert.equal(I.resolveLinkInIndex(idx, "Other|Label"), null)
  })
})

describe("stage-1: wiki walk memory cap", () => {
  it("pages beyond the byte budget are not indexed (first page always loads)", async () => {
    const wt = mkWorktree()
    const wiki = path.join(wt, ".hippocampus", "wiki")
    fs.mkdirSync(wiki, { recursive: true })
    // written directly to disk (bypassing wikiWriteFile's 256 KB per-page limit) — the pathological dump scenario the cap guards against
    fs.writeFileSync(path.join(wiki, "a-big.md"), `---\ntitle: Big\n---\n` + "x".repeat(I.WIKI_WALK_MAX_BODY_BYTES + 1024 * 1024))
    fs.writeFileSync(path.join(wiki, "b-small.md"), "---\ntitle: Small\n---\nsmall body")
    const pages = await I.wikiList(path.join(wt, ".hippocampus"))
    assert.equal(pages.length, 1, `expected only the first page to be indexed, got ${pages.map((p) => p.path).join(", ")}`)
    assert.equal(pages[0].path, "a-big.md")
  })
})
