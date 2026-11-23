// Run from repo root: node --experimental-strip-types --test tests/hippocampus.test.ts
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { createHash } from "node:crypto"

process.env.HIPPO_TEST = "1"
await import("../hippocampus/hippocampus.ts")
const I = (globalThis as any).__hippoInternals

function freshRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hippo-test-"))
}

function rmrf(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true })
  } catch {}
}

// ---------- redaction ----------
describe("redactSecrets", () => {
  it("masks token prefixes and quoted keys", () => {
    const s = I.redactSecrets('key sk-abcdef1234567890XYZ ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123 AKIAABCDEFGHIJKLMNOP "api_key": "hunter2secret"')
    assert.ok(!s.includes("sk-abcdef"))
    assert.ok(!s.includes("ghp_ABCDEF"))
    assert.ok(!s.includes("AKIAABCD"))
    assert.ok(s.includes('"api_key": "[REDACTED]"'))
  })

  it("masks PEM blocks, bearer and URL credentials", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEfakebody\n-----END RSA PRIVATE KEY-----"
    let s = I.redactSecrets(`x ${pem} y`)
    assert.ok(s.includes("[REDACTED]") && !s.includes("MIIEfakebody"))
    s = I.redactSecrets("Authorization: Bearer abcdef1234567890abcdef")
    assert.ok(!s.includes("abcdef1234567890abcdef"))
    s = I.redactSecrets("http://user:secretpass@host/x")
    assert.ok(!s.includes("secretpass"))
  })

  it("masks env-style sensitive assignments", () => {
    const s = I.redactSecrets("DATABASE_PASSWORD=SuperSecret123 FOO=bar")
    assert.ok(s.includes("DATABASE_PASSWORD=[REDACTED]"))
    assert.ok(s.includes("FOO=bar")) // non-sensitive key untouched
  })
})

// ---------- evictor (buildWindow) ----------
function mkUnit(id: string, userText: string, output: string): any {
  return [
    { info: { id: `u_${id}`, role: "user", time: { created: Date.now(), completed: Date.now() } }, parts: [{ id: `t_${id}a`, type: "text", text: userText }] },
    {
      info: { id: `a_${id}`, role: "assistant", time: { created: Date.now(), completed: Date.now() } },
      parts: [
        { id: `p_${id}`, type: "tool", tool: "shell", callID: `c_${id}`, state: { input: {}, output } },
        { id: `x_${id}`, type: "text", text: `done ${id}` },
      ],
    },
  ]
}

describe("buildWindow (aggressive evictor)", () => {
  it("stays under the hard cap and keeps user messages intact", () => {
    const big = "B".repeat(28000) // ~8k tokens each
    const msgs: any[] = []
    for (const id of ["A", "B", "C"]) msgs.push(...mkUnit(id, `question ${id}`, `${big} SENTINEL_${id}`))
    const res = I.buildWindow(msgs, "ses_test", 40000) // cap = 10k tokens
    assert.ok(res.stats.totalTokens <= res.stats.capTokens, `total ${res.stats.totalTokens} > cap ${res.stats.capTokens}`)
    assert.ok(res.stats.evictedCount >= 1)
    const allText = JSON.stringify(res.messages)
    // the kept (last) unit's user message is intact
    assert.ok(allText.includes("question C"))
  })

  it("sticky: never un-evicts across calls", () => {
    const big = "B".repeat(28000)
    let msgs: any[] = []
    for (const id of ["A", "B", "C"]) msgs.push(...mkUnit(id, `question ${id}`, `${big} SENTINEL_${id}`))
    const first = I.buildWindow(msgs, "ses_sticky", 40000)
    assert.ok(first.stats.evictedCount >= 1)

    // new tiny unit arrives; previously evicted units must stay evicted
    msgs.push(...mkUnit("D", "tiny question", "ok"))
    const second = I.buildWindow(msgs, "ses_sticky", 40000, undefined, undefined, undefined, undefined, first.stats.evictedCount)
    assert.ok(second.stats.evictedCount >= first.stats.evictedCount)
    const allText = JSON.stringify(second.messages)
    assert.ok(allText.includes("tiny question"))
    // evicted units' big outputs are gone from the window (only their marker hints remain)
    const keptOutputs = second.messages.map((m: any) => m.parts.map((p: any) => p.state?.output ?? "").join("")).join("")
    assert.ok(!keptOutputs.includes("SENTINEL_A") && !keptOutputs.includes("SENTINEL_B"), "evicted units leaked into window")
  })

  it("forced pass: single huge tool output gets stubbed even in the active unit", () => {
    const huge = "H".repeat(350000) // ~100k tokens, far above cap
    const msgs: any[] = mkUnit("X", "one big question", `${huge} SENTINEL_X`)
    const res = I.buildWindow(msgs, "ses_forced", 40000)
    assert.equal(res.stats.forced, true)
    assert.ok(res.stats.totalTokens <= res.stats.capTokens)
    const toolPart = res.messages.flatMap((m: any) => m.parts).find((p: any) => p.type === "tool")
    assert.ok(toolPart.state.output.includes("output (full)") && toolPart.state.output.includes("#t_c_X"))
    assert.ok(!toolPart.state.output.includes("SENTINEL_X")) // only head/tail preview, not the middle
    assert.ok(res.messages[0].parts.some((p: any) => p.type === "text" && p.text.includes("one big question")))
  })

  it("small history passes through unchanged (no eviction, no stubs)", () => {
    const msgs: any[] = mkUnit("S", "hello", "short output")
    const res = I.buildWindow(msgs, "ses_small", 131072)
    assert.equal(res.stats.evictedCount, 0)
    assert.equal(res.stats.forced, false)
    const toolPart = res.messages.flatMap((m: any) => m.parts).find((p: any) => p.type === "tool")
    assert.equal(toolPart.state.output, "short output")
  })
})

// ---------- lookup with line ranges ----------
describe("contextLookup", () => {
  const root = freshRoot()
  it("serves TOC, segments, tool blocks and line ranges", async () => {
    const rawDir = path.join(root, ".hippocampus", "raw")
    fs.mkdirSync(rawDir, { recursive: true })
    const file = [
      "# session ses_lookup · /tmp · started 2026-10-23T00:00:00Z",
      "",
      '## u_unit1 · 00:00:01 · user→assistant×1 · ~5 tok · "first question"',
      "<!-- m_m1 -->",
      "[user]",
      "hello one",
      "",
      "<!-- m_m2 -->",
      "[tool shell call args={}]",
      "",
      "### t_c1 · shell · (~3 tok)",
      "line1",
      "line2",
      "line3",
      "",
      '## u_unit2 · 00:00:02 · user→assistant×1 · ~5 tok · "second question"',
      "<!-- m_m3 -->",
      "[user]",
      "hello two",
      "",
    ].join("\n") + "\n"
    fs.writeFileSync(path.join(rawDir, "ses_lookup.md"), file)

    const toc = await I.contextLookup(root, undefined, "", 65536)
    assert.ok(toc.includes("u_unit1") && toc.includes("u_unit2"))

    const seg = await I.contextLookup(root, undefined, "u_unit1", 65536)
    assert.ok(seg.startsWith("## u_unit1"))
    assert.ok(seg.includes("hello one") && seg.includes("line3"))
    assert.ok(!seg.includes("hello two"))

    const blk = await I.contextLookup(root, undefined, "t_c1", 65536)
    assert.ok(blk.startsWith("### t_c1"))
    assert.ok(blk.includes("line1") && !blk.includes("[user]"))

    // block lines are 1-based including the header: [### t_c1…, line1, line2, line3]
    const ranged = await I.contextLookup(root, undefined, "t_c1:2-4", 65536)
    assert.ok(ranged.startsWith("[lines 2-4 of 4]"), ranged.slice(0, 60))
    assert.ok(ranged.includes("line1") && ranged.includes("line3"))
    assert.ok(!ranged.includes("### t_c1")) // header excluded from the slice

    const single = await I.contextLookup(root, undefined, "t_c1:4", 65536)
    assert.ok(single.startsWith("[lines 4-4 of 4]"))
    assert.ok(single.includes("line3") && !single.includes("line2"))

    assert.match(await I.contextLookup(root, undefined, "u_nope", 65536), /not found/)
    assert.match(await I.contextLookup(root, undefined, "bogus", 65536), /target must be/)
    rmrf(root)
  })
})

// ---------- frontmatter ----------
describe("wiki frontmatter", () => {
  it("round-trips serialize/parse and keeps extra keys", () => {
    const text = I.serializePage(
      { title: "Build", type: "concept", description: "how to build", sources: "ses_a,ses_b", valid_from: "2026-10-01", status: "proposed" },
      "body with [[Link]] inside",
    )
    const p = I.parseFrontmatter(text)
    assert.equal(p.fm.title, "Build")
    assert.equal(p.fm.type, "concept")
    assert.equal(p.fm.status, "proposed")
    assert.equal(p.body.trimEnd(), "body with [[Link]] inside") // serializePage appends a trailing newline for file writes
  })

  it("treats frontmatter-less text as plain body", () => {
    const p = I.parseFrontmatter("just a body\nline two")
    assert.deepEqual(p.fm, {})
    assert.equal(p.body.trimEnd(), "just a body\nline two")
  })
})

// ---------- wiki FTS5 search + 1-hop ----------
describe("wiki search", () => {
  it("indexes pages and finds them with BM25 + related links", async () => {
    const root = freshRoot()
    const hroot = path.join(root, ".hippocampus")
    const wikiDir = path.join(hroot, "wiki")
    fs.mkdirSync(path.join(wikiDir, "concepts"), { recursive: true })
    fs.mkdirSync(path.join(wikiDir, "entities"), { recursive: true })
    fs.writeFileSync(
      path.join(wikiDir, "concepts", "build.md"),
      "---\ntitle: Build\ntype: concept\ndescription: how to build the thing\n---\n\nThe compile pipeline runs tests then packages.\n",
    )
    fs.writeFileSync(
      path.join(wikiDir, "entities", "db.md"),
      "---\ntitle: DB\ntype: entity\ndescription: postgres connection pool\n---\n\nPostgres holds the data. See [[Build]].\n",
    )

    const n = await I.rebuildWikiIndex(hroot)
    assert.equal(n, 2)
    assert.ok(fs.existsSync(path.join(wikiDir, "index.db")), "FTS5 index.db must exist (node:sqlite FTS5 mandatory)")

    const res = await I.wikiSearch(hroot, "postgres connection", 5)
    assert.ok(res.includes("entities/db.md"), res)
    assert.ok(res.includes("Related") && res.includes("concepts/build.md"), `1-hop expansion missing:\n${res}`)

    rmrf(root)
  })
})

// ---------- trigram search: substring + case-insensitive (Cyrillic) + short-term safety ----------
describe("trigram wiki search", () => {
  function seedWiki(hroot: string): void {
    const wikiDir = path.join(hroot, "wiki")
    fs.mkdirSync(path.join(wikiDir, "concepts"), { recursive: true })
    // Cyrillic body with a capitalized word; ASCII body. Substring + case targets for trigram.
    fs.writeFileSync(
      path.join(wikiDir, "concepts", "stereo.md"),
      "---\ntitle: Stereo\ntype: concept\ndescription: audio amplifier\n---\n\nThe Стереза amp drives the Hello World speakers and says hi.\n",
    )
  }

  it("matches a substring inside a word (unicode61 could not)", async () => {
    const root = freshRoot()
    const hroot = path.join(root, ".hippocampus")
    seedWiki(hroot)
    await I.rebuildWikiIndex(hroot)
    // "стерез" is a strict substring of "Стереза"; unicode61 token match would miss it.
    const res = await I.wikiSearch(hroot, "стерез", 5)
    assert.ok(res.includes("concepts/stereo.md"), `substring 'стерез' should hit stereo.md:\n${res}`)
    rmrf(root)
  })

  it("is case-insensitive for Cyrillic (uppercase query vs capitalized body)", async () => {
    const root = freshRoot()
    const hroot = path.join(root, ".hippocampus")
    seedWiki(hroot)
    await I.rebuildWikiIndex(hroot)
    // Body has "Стереза" (capital С); an uppercase user query must still match.
    // (trigram only folds ASCII case — the lowercased storage in wikiUpsert is what makes this work.)
    const res = await I.wikiSearch(hroot, "СТЕРЕЗ", 5)
    assert.ok(res.includes("concepts/stereo.md"), `case-insensitive Cyrillic failed:\n${res}`)
    rmrf(root)
  })

  it("drops <3-char terms from AND queries instead of zeroing the result", async () => {
    const root = freshRoot()
    const hroot = path.join(root, ".hippocampus")
    seedWiki(hroot)
    await I.rebuildWikiIndex(hroot)
    // "hi" is 2 chars → trigram can't match it. With a long term present the search must still work.
    const res = await I.wikiSearch(hroot, "stereo hi", 5)
    assert.ok(res.includes("concepts/stereo.md"), `short+long AND query should match on the long term:\n${res}`)
    rmrf(root)
  })

  it("falls back to substring scan when every term is <3 chars", async () => {
    const root = freshRoot()
    const hroot = path.join(root, ".hippocampus")
    seedWiki(hroot)
    await I.rebuildWikiIndex(hroot)
    // "hi" alone → ftsQuery returns null → substring scan must find it in the body.
    const res = await I.wikiSearch(hroot, "hi", 5)
    assert.ok(res.includes("concepts/stereo.md"), `short-only query should hit via fallback:\n${res}`)
    rmrf(root)
  })

  it("returns 'empty query' for blank input only", async () => {
    const root = freshRoot()
    const hroot = path.join(root, ".hippocampus")
    seedWiki(hroot)
    await I.rebuildWikiIndex(hroot)
    assert.equal((await I.wikiSearch(hroot, "   ", 5)), "empty query")
    rmrf(root)
  })

  it("invalidates the FTS result cache on rebuild and on in-place upsert", async () => {
    const root = freshRoot()
    const hroot = path.join(root, ".hippocampus")
    seedWiki(hroot)
    await I.rebuildWikiIndex(hroot)

    // Prime the cache with a query that hits.
    assert.ok((await I.wikiSearch(hroot, "stereo", 5)).includes("concepts/stereo.md"))
    const again = await I.wikiSearch(hroot, "stereo", 5)
    assert.ok(again.includes("concepts/stereo.md"), `cached repeat should still hit:\n${again}`)

    // Rewrite the page in place so "stereo" disappears from body/title/description.
    const file = path.join(hroot, "wiki/concepts/stereo.md")
    fs.writeFileSync(file, "---\ntitle: Amp\ntype: concept\ndescription: audio\n---\n\nJust an amp now.\n")
    await I.indexWikiPage(hroot, "concepts/stereo.md")

    // The cached row must NOT be served after the in-place mutation.
    const after = await I.wikiSearch(hroot, "stereo", 5)
    assert.ok(!after.includes("concepts/stereo.md"), `stale cache row survived upsert:\n${after}`)

    // And a full rebuild also invalidates: re-add the term, rebuild, expect a hit.
    fs.writeFileSync(file, "---\ntitle: Stereo\ntype: concept\ndescription: audio\n---\n\nStereo is back.\n")
    await I.rebuildWikiIndex(hroot)
    const afterRebuild = await I.wikiSearch(hroot, "stereo", 5)
    assert.ok(afterRebuild.includes("concepts/stereo.md"), `post-rebuild search should hit:\n${afterRebuild}`)
    rmrf(root)
  })

  it("migrates a pre-trigram (unicode61) index.db on open and then finds substrings", async () => {
    const root = freshRoot()
    const hroot = path.join(root, ".hippocampus")
    seedWiki(hroot)
    const wikiDir = path.join(hroot, "wiki")

    // Simulate an old plugin version: build a unicode61 index.db on disk first.
    const db = new DatabaseSync(path.join(wikiDir, "index.db"))
    db.exec(
      `CREATE TABLE pages(rowid INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, title TEXT, type TEXT, description TEXT, sources TEXT, source_session TEXT, valid_from TEXT, valid_until TEXT, mtime INTEGER);`,
    )
    db.exec(`CREATE VIRTUAL TABLE wiki_fts USING fts5(path UNINDEXED, title, description, body, tokenize='unicode61');`)
    const text = fs.readFileSync(path.join(wikiDir, "concepts/stereo.md"), "utf8")
    const { parseFrontmatter } = I as any
    const parsed = parseFrontmatter(text)
    db.prepare("INSERT INTO pages VALUES (1,'concepts/stereo.md','Stereo','concept','audio amplifier','','','','',0)").run()
    db.prepare("INSERT INTO wiki_fts(path,title,description,body) VALUES ('concepts/stereo.md','stereo','audio amplifier',?)").run(parsed.body)
    const oldSql: any = db.prepare(`SELECT sql FROM sqlite_master WHERE name='wiki_fts'`).get()
    assert.ok(/unicode61/.test(String(oldSql.sql)), "precondition: seeded index uses unicode61")
    db.close()

    // openWikiDb must drop+recreate as trigram; a substring query then works.
    const res = await I.wikiSearch(hroot, "стерез", 5)
    assert.ok(res.includes("concepts/stereo.md"), `post-migration substring search failed:\n${res}`)

    // The on-disk schema is now trigram.
    const db2 = new DatabaseSync(path.join(wikiDir, "index.db"), { readOnly: true })
    const newSql: any = db2.prepare(`SELECT sql FROM sqlite_master WHERE name='wiki_fts'`).get()
    assert.ok(/trigram/i.test(String(newSql.sql)), `expected trigram schema after migration, got:\n${newSql.sql}`)
    db2.close()
    rmrf(root)
  })
})

// ---------- consolidation ----------
describe("consolidate", () => {
  it("dedups, TTLs, removes dangling links and drafts SOP pages", async () => {
    const root = freshRoot()
    const wikiDir = path.join(root, ".hippocampus", "wiki")
    fs.mkdirSync(path.join(wikiDir, "concepts"), { recursive: true })
    fs.mkdirSync(path.join(root, ".hippocampus", "memfs"), { recursive: true })
    fs.mkdirSync(path.join(root, ".hippocampus", "raw"), { recursive: true })

    const page = (title: string) => `---\ntitle: ${title}\ntype: concept\ndescription: d\nvalid_until: 2099-01-01\n---\n\nSame body text here.\n`
    fs.writeFileSync(path.join(wikiDir, "concepts", "dup-a.md"), page("Dup A"))
    fs.writeFileSync(path.join(wikiDir, "concepts", "dup-b.md"), page("Dup B"))

    const expired = `---\ntitle: Old\ntype: concept\ndescription: d\nvalid_until: 2020-01-01\n---\n\nexpired body\n`
    fs.writeFileSync(path.join(wikiDir, "concepts", "old.md"), expired)

    const linked = `---\ntitle: Links\ntype: concept\ndescription: d\n---\n\nSee [[Missing Page]] and [[Dup A]].\n`
    fs.writeFileSync(path.join(wikiDir, "concepts", "links.md"), linked)

    // stale memfs note (40 days old > default 30d ttl)
    const note = path.join(root, ".hippocampus", "memfs", "stale.md")
    fs.writeFileSync(note, "old notes\n")
    const t = Date.now() / 1000 - 40 * 24 * 60 * 60
    fs.utimesSync(note, t, t)

    // two raw sessions with the same tool 3-sequence → SOP candidate
    for (const s of ["ses_sop_1", "ses_sop_2"]) {
      fs.writeFileSync(
        path.join(root, ".hippocampus", "raw", `${s}.md`),
        "# session\n\n## u_x\n<!-- m_1 -->\n[user]\nhi\n\n[tool alpha call args={}]\n\n### t_1 · alpha · (~1 tok)\nout\n\n[tool beta call args={}]\n\n### t_2 · beta · (~1 tok)\nout\n\n[tool gamma call args={}]\n\n### t_3 · gamma · (~1 tok)\nout\n",
      )
    }

    const report = await I.consolidate(root, { ...I_DEFAULTS() })
    assert.match(report, /dedup: removed/)
    assert.match(report, /ttl: archived concepts\/old\.md/)
    assert.ok(!fs.existsSync(path.join(wikiDir, "concepts", "old.md")))
    assert.ok(fs.existsSync(path.join(wikiDir, "archive", "concepts", "old.md")), "expired page moved to wiki/archive/")

    const linksAfter = fs.readFileSync(path.join(wikiDir, "concepts", "links.md"), "utf8")
    assert.ok(!linksAfter.includes("[[Missing Page]]"), `dangling link not removed:\n${linksAfter}`)
    assert.ok(linksAfter.includes("Missing Page")) // plain text kept

    const sop = path.join(wikiDir, "skills", "alpha-beta-gamma.md")
    assert.ok(fs.existsSync(sop), `SOP draft missing (report: ${report})`)
    assert.match(report, /index: rebuilt/)

    // re-run: an existing SOP page must never be overwritten or re-drafted
    const sopBefore = fs.readFileSync(sop, "utf8")
    const report2 = await I.consolidate(root, { ...I_DEFAULTS() })
    assert.ok(!report2.includes("sop:"), `second run must not re-draft existing SOP pages: ${report2}`)
    assert.equal(fs.readFileSync(sop, "utf8"), sopBefore, "existing SOP page content must be unchanged")
    rmrf(root)
  })
})

// ---------- user media archiving + attachment substitution ----------
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

function mkImageMsg(id: string, b64: string, mime = "image/png"): any {
  return { info: { id, role: "user", time: { created: Date.now(), completed: Date.now() } }, parts: [{ id: `${id}_f`, type: "file", mime, url: `data:${mime};base64,${b64}` }] }
}

describe("saveAttachment (base64 media)", () => {
  it("saves to attachments/<sha256-16>.<ext> and dedups by content hash", async () => {
    const root = freshRoot()
    try {
      const hroot = I.hippoRoot(root) // saveAttachment takes the .hippocampus dir, like logUserMessageV2 does
      const url = `data:image/png;base64,${PNG_1PX}`
      const a = await I.saveAttachment(hroot, "image/png", url)
      assert.equal(a.saved, true)
      const b = await I.saveAttachment(hroot, "image/png", url) // same bytes again
      assert.equal(a.ref, b.ref)
      const file = path.join(hroot, "attachments", path.basename(a.ref))
      assert.ok(fs.existsSync(file), `missing ${a.ref}`)
      assert.match(a.ref, /^\.hippocampus\/attachments\/[0-9a-f]{16}\.png$/)
    } finally {
      rmrf(root)
    }
  })

  it("archives any mime (no whitelist) and still refuses oversized payloads without throwing", async () => {
    const root = freshRoot()
    try {
      const hroot = I.hippoRoot(root)
      // Previously refused mimes are now archived: an unarchived data: URL would live base64 in every request forever.
      const html = await I.saveAttachment(hroot, "text/html", `data:text/html;base64,${Buffer.from("<b>x</b>").toString("base64")}`)
      assert.equal(html.saved, true)
      assert.match(html.ref, /^\.hippocampus\/attachments\/[0-9a-f]{16}\.html$/)
      const bin = await I.saveAttachment(hroot, "application/x-custom", `data:application/x-custom;base64,${Buffer.from("zz").toString("base64")}`)
      assert.equal(bin.saved, true)
      assert.match(bin.ref, /\.xcustom$/) // ext derived from the mime subtype; .bin only when the subtype has no alphanumerics
      const big = await I.saveAttachment(hroot, "image/png", `data:image/png;base64,${"A".repeat(12 * 1024 * 1024)}`) // decodes to ~9 MB > 8 MB limit
      assert.equal(big.saved, false)
      assert.match(big.ref, /too large/)
    } finally {
      rmrf(root)
    }
  })
})

describe("archiveUserMedia + substituteArchivedAttachments", () => {
  it("archives user base64 images to disk and replaces them with refs only after the model answered", async () => {
    const root = freshRoot()
    try {
      // unique bytes per test run so the module-level dedup set doesn't hide misses
      const b64 = Buffer.from(`img-${Date.now()}-${Math.random()}`).toString("base64")
      const answered = mkImageMsg("u1", b64)
      const assistant: any = { info: { id: "a1", role: "assistant" }, parts: [{ id: "p1", type: "text", text: "ok" }] }
      const pending = mkImageMsg("u2", b64) // no assistant after → must keep base64

      const hroot = I.hippoRoot(root)
      await I.archiveUserMedia([answered, assistant, pending], root)
      const hash = I.attachmentHash(answered.parts[0].url)
      assert.ok(hash, "hash derived")
      assert.ok(fs.existsSync(path.join(hroot, "attachments", `${hash}.png`)), "image written to disk")

      // second run: no throw, idempotent (dedup set hit)
      await I.archiveUserMedia([answered], root)

      const sub = I.substituteArchivedAttachments([answered, assistant, pending], root)
      assert.equal(sub[0].parts[0].type, "text")
      assert.match(String(sub[0].parts[0].text), new RegExp(`^\\[attachment saved: \\.hippocampus/attachments/${hash}\\.png\\]$`))
      // unanswered turn keeps the real base64 for the current model request
      assert.equal(sub[2].parts[0].type, "file")
      assert.ok(String(sub[2].parts[0].url).startsWith("data:image/png;base64,"))
      // substitution is idempotent on already-substituted messages
      const sub2 = I.substituteArchivedAttachments(sub, root)
      assert.equal(sub2[0], sub[0])

      // assistant and non-archived parts are untouched
      assert.equal(sub[1].parts[0].type, "text")
    } finally {
      rmrf(root)
    }
  })

  it("archives previously-whitelisted-out mimes (text/html) and substitutes them after the answer", async () => {
    const root = freshRoot()
    try {
      const b64 = Buffer.from(`html-${Date.now()}`).toString("base64")
      const msg: any = { info: { id: "u3", role: "user" }, parts: [{ id: "f3", type: "file", mime: "text/html", url: `data:text/html;base64,${b64}` }] }
      const assistant: any = { info: { id: "a3", role: "assistant" }, parts: [] }
      await I.archiveUserMedia([msg], root) // text/html is archived now (no whitelist)
      const hash = I.attachmentHash(msg.parts[0].url)
      assert.ok(fs.existsSync(path.join(I.hippoRoot(root), "attachments", `${hash}.html`)), "html written to disk")
      const sub = I.substituteArchivedAttachments([msg, assistant], root)
      assert.equal(sub[0].parts[0].type, "text") // replaced with a short ref after the model answered
      assert.match(String(sub[0].parts[0].text), new RegExp(`^\\[attachment saved: \\.hippocampus/attachments/${hash}\\.html\\]$`))
    } finally {
      rmrf(root)
    }
  })

  it("warns once for unarchivable attachments and never re-hashes/re-warns on later calls", async () => {
    const root = freshRoot()
    try {
      // ~9 MB decoded > default maxAttachmentBytes → skipped, not archived
      const b64 = "A".repeat(12 * 1024 * 1024)
      const msg: any = { info: { id: "u4", role: "user" }, parts: [{ id: "f4", type: "file", mime: "image/png", url: `data:image/png;base64,${b64}` }] }
      await I.archiveUserMedia([msg], root)
      assert.equal(fs.existsSync(path.join(I.hippoRoot(root), "attachments")), false)
      const sub = I.substituteArchivedAttachments([msg, { info: { id: "a4", role: "assistant" }, parts: [] }], root)
      assert.equal(sub[0].parts[0].type, "file") // still base64 — nothing was archived to point at
    } finally {
      rmrf(root)
    }
  })
})

// ---------- leveled logging (.hippocampus/logs/<date>.log) ----------
describe("leveled logging (.hippocampus/logs)", () => {
  function todayLog(root: string): string {
    return path.join(I.hippoRoot(root), "logs", `${new Date().toISOString().slice(0, 10)}.log`)
  }
  function readLog(root: string): string {
    try {
      return fs.readFileSync(todayLog(root), "utf8")
    } catch {
      return ""
    }
  }

  it("default level=error: only errors land in logs/<date>.log", async () => {
    const root = freshRoot()
    try {
      await I.logEvent(root, "trace", "t", "nope-trace")
      await I.logEvent(root, "debug", "d", "nope-debug")
      await I.logEvent(root, "info", "i", "nope-info")
      await I.logEvent(root, "error", "boom", new Error("kapow"))
      const log = readLog(root)
      assert.ok(!log.includes("nope"), "trace/debug/info must be filtered at the default level")
      assert.match(log, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z ERROR \[boom\] Error: kapow/)
    } finally {
      rmrf(root)
    }
  })

  it("config logLevel=debug admits debug+error (validated by loadConfig)", async () => {
    const root = freshRoot()
    try {
      fs.mkdirSync(I.hippoRoot(root), { recursive: true })
      fs.writeFileSync(path.join(I.hippoRoot(root), "hippocampus.json"), JSON.stringify({ logLevel: "debug" }))
      I.applyLogLevel(root, (await I.loadConfig(root)).logLevel)
      await I.logEvent(root, "trace", "t", "still-nope")
      await I.logEvent(root, "debug", "d", "dbg-line")
      const log = readLog(root)
      assert.ok(!log.includes("still-nope"), "trace stays hidden at level=debug")
      assert.match(log, /DEBUG \[d\] dbg-line/)
    } finally {
      rmrf(root)
    }
  })

  it("log level comes only from hippocampus.json; env vars have no effect", async () => {
    const root = freshRoot()
    try {
      fs.mkdirSync(I.hippoRoot(root), { recursive: true })
      fs.writeFileSync(path.join(I.hippoRoot(root), "hippocampus.json"), JSON.stringify({ logLevel: "trace" }))
      I.applyLogLevel(root, (await I.loadConfig(root)).logLevel) // json says trace…
      process.env.HIPPO_LOG_LEVEL = "error" // …env must be ignored now
      await I.logEvent(root, "debug", "d", "json-wins")
      assert.match(readLog(root), /DEBUG \[d\] json-wins/)
    } finally {
      delete process.env.HIPPO_LOG_LEVEL
      rmrf(root)
    }
  })

  it("loadConfig parses capture/log-truncation keys with validation", async () => {
    const root = freshRoot()
    try {
      fs.mkdirSync(I.hippoRoot(root), { recursive: true })
      fs.writeFileSync(
        path.join(I.hippoRoot(root), "hippocampus.json"),
        JSON.stringify({ captureMaxCount: 7, captureMaxSessions: 2, maxToolOutputLogChars: 128, maxArgsLogChars: 32 }),
      )
      const cfg = await I.loadConfig(root)
      assert.equal(cfg.captureMaxCount, 7)
      assert.equal(cfg.captureMaxSessions, 2)
      assert.equal(cfg.maxToolOutputLogChars, 128)
      assert.equal(cfg.maxArgsLogChars, 32)
      // invalid values fall back to defaults
      fs.writeFileSync(path.join(I.hippoRoot(root), "hippocampus.json"), JSON.stringify({ captureMaxCount: 0, maxArgsLogChars: 4 }))
      const cfg2 = await I.loadConfig(root)
      assert.equal(cfg2.captureMaxCount, 500)
      assert.equal(cfg2.maxArgsLogChars, 1024)
    } finally {
      rmrf(root)
    }
  })

  it("invalid config level falls back to default; unsafe worktrees are never logged", async () => {
    const root = freshRoot()
    try {
      fs.mkdirSync(I.hippoRoot(root), { recursive: true })
      fs.writeFileSync(path.join(I.hippoRoot(root), "hippocampus.json"), JSON.stringify({ logLevel: "VERBOSE" }))
      assert.equal((await I.loadConfig(root)).logLevel, "error") // default kept
    } finally {
      rmrf(root)
    }
    await I.logEvent("/", "trace", "x", "must-not-exist")
    await I.logEvent("/", "error", "x", "also-nope")
    assert.equal(fs.existsSync(path.join("/", ".hippocampus")), false)
  })

  it("prune of the logs dir respects maxLogBytes and keeps the newest file", async () => {
    const root = freshRoot()
    try {
      const logsDir = path.join(I.hippoRoot(root), "logs")
      fs.mkdirSync(logsDir, { recursive: true })
      // three daily files; make two of them old via mtime
      for (const [name, ageDays] of [["2026-01-01.log", 90], ["2026-01-02.log", 89], ["2026-10-23.log", 0]] as Array<[string, number]>) {
        const f = path.join(logsDir, name)
        fs.writeFileSync(f, "x".repeat(1024))
        if (ageDays > 0) {
          const t = new Date(Date.now() - ageDays * 86400_000)
          fs.utimesSync(f, t, t)
        }
      }
      await I.pruneDir(root, logsDir, ".log", 1536, 90) // age > 90d drops 2026-01-01; size cap 1.5 KiB then drops the oldest survivor (newest file is never deleted)
      const left = fs.readdirSync(logsDir).sort()
      assert.deepEqual(left, ["2026-10-23.log"])
    } finally {
      rmrf(root)
    }
  })
})

// ---------- audit round-3 fixes ----------
describe("audit-round-3: data URL params before ;base64", () => {
  const sha = (s: Buffer | string): string => createHash("sha256").update(s).digest("hex").slice(0, 16)
  it("parseDataUrl accepts charset param before ;base64", () => {
    assert.deepEqual(I.parseDataUrl("data:text/plain;charset=utf-8;base64,SGVsbG8="), { mime: "text/plain", base64: true, raw: "SGVsbG8=" })
  })
  it("parseDataUrl accepts params on plain URLs and an empty header", () => {
    assert.deepEqual(I.parseDataUrl("data:text/plain;charset=utf-8,hi%20there"), { mime: "text/plain", base64: false, raw: "hi%20there" })
    assert.deepEqual(I.parseDataUrl("data:,x"), { mime: "", base64: false, raw: "x" })
  })
  it("parseDataUrl rejects non-data URLs and headerless garbage", () => {
    assert.equal(I.parseDataUrl("https://example.com/x.png"), null)
    assert.equal(I.parseDataUrl("data:"), null)
  })
  it("attachmentHash hashes decoded bytes of a params data URL (was '' before the fix)", () => {
    const payload = "Hello, мир"
    const b64 = Buffer.from(payload).toString("base64")
    assert.equal(I.attachmentHash(`data:text/plain;charset=utf-8;base64,${b64}`), sha(Buffer.from(payload)))
  })
})

describe("audit-round-3: v2ToLegacy does not fabricate assistant completion", () => {
  it("assistant stays open (completed undefined); user is complete by definition", () => {
    const leg = I.v2ToLegacy([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ])
    assert.equal(typeof leg[0].info.time.completed, "number")
    assert.equal(leg[1].info.time.completed, undefined) // open until session.idle flushes with finished:true (#11)
  })
})

describe("audit-round-3: doWriteUnits defers an open assistant in the last unit", () => {
  it("context-style write skips it; finished:true (idle) archives it", async () => {
    const wt = freshRoot()
    try {
      const [u] = I.v2ToLegacy([{ role: "user", content: [{ type: "text", text: "question one" }] }])
      const [a] = I.v2ToLegacy([{ role: "assistant", content: [{ type: "text", text: "answer-one-unique" }] }])
      assert.equal(a.info.time.completed, undefined)
      const log = I.getSessionLog(wt, "ses_defer")
      await log.writeUnits([u, a], {}) // context-hook style — no finished
      let raw = fs.readFileSync(path.join(wt, ".hippocampus", "raw", "ses_defer.md"), "utf8")
      assert.ok(raw.includes(`<!-- m_${u.info.id} -->`), "user message must be archived immediately")
      assert.ok(!raw.includes("answer-one-unique"), "open assistant in the last unit must wait for idle")
      await log.writeUnits([u, a], { finished: true }) // session.idle style
      raw = fs.readFileSync(path.join(wt, ".hippocampus", "raw", "ses_defer.md"), "utf8")
      assert.ok(raw.includes("answer-one-unique"), "idle flush must archive the assistant")
    } finally {
      rmrf(wt)
    }
  })
})

function I_DEFAULTS(): any {
  // minimal config for consolidate tests (defaults mirror DEFAULT_CONFIG)
  return { memfsTtlDays: 30 }
}

// ---------- stage-2 perf: buildWindow identity + system-block TTL ----------
describe("stage-2: buildWindow metrics memoization keeps output byte-identical", () => {
  it("stats and messages match the pre-memoization golden exactly", () => {
    // Deterministic history (fixed timestamp base): 40 units × 5 tool parts (4 KB) + 12 text pairs.
    // The golden was captured from commit c1f06cd (pre stage-2, no memoization); any change in token math or rendering breaks the hash.
    function randText(i: number, len: number): string {
      let x = (i * 2654435761) >>> 0
      const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return (x >>> 0) / 4294967296 }
      const words = ["alpha", "beta", "запись", "память", "контекст", "stub", "marker"]
      let out = ""
      while (out.length < len) { const w = words[Math.floor(rnd() * words.length)] + Math.floor(rnd() * 1000); out += (out ? " " : "") + w }
      return out.slice(0, len)
    }
    const now = 1763000000000
    let n = 0
    const msgs: any[] = []
    for (let u = 0; u < 40; u++) {
      const uid = `u${String(u).padStart(3, "0")}`
      msgs.push({ info: { id: `m_${uid}_user`, role: "user", time: { created: now + n++, completed: now + n++ } }, parts: [{ id: `p_${uid}_u`, type: "text", text: randText(u, 240) }] })
      const parts = []
      for (let t = 0; t < 5; t++) {
        parts.push({ id: `p_${uid}_t${t}`, type: "tool", tool: t % 2 === 0 ? "shell" : "read", callID: `c_${uid}_${t}`, state: { input: { cmd: randText(u * 5 + t, 80) }, output: randText(u * 131 + t, 4096) } })
      }
      parts.push({ id: `p_${uid}_a`, type: "text", text: `done ${u}` })
      msgs.push({ info: { id: `m_${uid}_asst`, role: "assistant", time: { created: now + n++, completed: now + n++ } }, parts })
    }
    for (let t = 0; t < 12; t++) {
      const id = `xt${t}`
      msgs.push({ info: { id: `m_${id}_u`, role: "user", time: { created: now + n++, completed: now + n++ } }, parts: [{ id: `p_${id}_u`, type: "text", text: randText(9000 + t, 300) }] })
      msgs.push({ info: { id: `m_${id}_a`, role: "assistant", time: { created: now + n++, completed: now + n++ } }, parts: [{ id: `p_${id}_a`, type: "text", text: randText(9500 + t, 300) }] })
    }
    const r = I.buildWindow(msgs, "golden_ses", 32768)
    // compactionCount was added by stage-2.3 (always 0 here — no marker in the history); firstId/units by stage-3 head tracking; every other field matches the pre-stage-2 golden.
    assert.deepEqual(r.stats, { totalTokens: 2588, capTokens: 6553, evictedCount: 40, forced: false, firstId: "m_u000_user", units: 52, compactionCount: 0 })
    assert.equal(createHash("sha256").update(JSON.stringify(r.messages)).digest("hex"), "81b28b6f2f2d6ec062e2743a341472d9dd6d41990720159a3ae851ba2afc32a7")
  })
})

describe("stage-2: compileSystemBlock TTL cache", () => {
  function seed(root: string, persona: string): void {
    const h = I.hippoRoot(root)
    fs.mkdirSync(path.join(h, "memfs/work"), { recursive: true })
    fs.writeFileSync(path.join(h, "core-memory.md"), `# CORE\n## PERSONA\n${persona}`)
    fs.writeFileSync(path.join(h, "memfs/work/note.md"), "note body")
  }

  it("fresh entry is served from cache; manual core edit lands after invalidation", async () => {
    const root = freshRoot()
    try {
      seed(root, "persona-v1")
      const b1 = await I.compileSystemBlock(root, 60_000)
      assert.ok(b1.includes("persona-v1"))
      // Manual disk edit within the TTL: the fast path must not see it (no disk access while fresh).
      fs.writeFileSync(path.join(I.hippoRoot(root), "core-memory.md"), "# CORE\n## PERSONA\npersona-v2")
      const b2 = await I.compileSystemBlock(root, 60_000)
      assert.equal(b2, b1) // still the cached block — manual edits are picked up by TTL expiry
      // invalidateSystemBlock forces an immediate rebuild (what the memory-write tools call).
      I.invalidateSystemBlock(root)
      const b3 = await I.compileSystemBlock(root, 60_000)
      assert.ok(b3.includes("persona-v2"), "invalidation must re-read disk")
    } finally {
      rmrf(root)
    }
  })

  it("ttl=0 disables the cache: every call re-checks disk", async () => {
    const root = freshRoot()
    try {
      seed(root, "persona-v1")
      await I.compileSystemBlock(root, 0)
      fs.writeFileSync(path.join(I.hippoRoot(root), "core-memory.md"), "# CORE\n## PERSONA\npersona-v2")
      const b2 = await I.compileSystemBlock(root, 0)
      assert.ok(b2.includes("persona-v2"))
    } finally {
      rmrf(root)
    }
  })

  it("config: default 5000 ms, accepts >= 0, rejects negative", async () => {
    const root = freshRoot()
    try {
      assert.equal(I.DEFAULT_CONFIG.systemBlockTtlMs, 5000)
      let cfg = await I.loadConfig(root)
      assert.equal(cfg.systemBlockTtlMs, 5000) // no config file → default
      fs.mkdirSync(I.hippoRoot(root), { recursive: true })
      const p = path.join(I.hippoRoot(root), "hippocampus.json")
      fs.writeFileSync(p, JSON.stringify({ systemBlockTtlMs: 1234 }))
      cfg = await I.loadConfig(root)
      assert.equal(cfg.systemBlockTtlMs, 1234)
      fs.writeFileSync(p, JSON.stringify({ systemBlockTtlMs: -5 }))
      cfg = await I.loadConfig(root)
      assert.equal(cfg.systemBlockTtlMs, 5000) // negative rejected → default kept
    } finally {
      rmrf(root)
    }
  })
})

describe("stage-2: substituteArchivedAttachments single-pass semantics", () => {
  it("substitutes every user turn with an assistant strictly after it, keeps the trailing unanswered one", async () => {
    const root = freshRoot()
    try {
      const a = mkImageMsg("ua", Buffer.from(`img-A-${Date.now()}`).toString("base64"))
      const b = mkImageMsg("ub", Buffer.from(`img-B-${Date.now()}-${Math.random()}`).toString("base64"))
      const asst: any = { info: { id: "as1", role: "assistant" }, parts: [{ id: "p1", type: "text", text: "ok" }] }
      const c = mkImageMsg("uc", Buffer.from(`img-C-${Date.now()}-${Math.random()}`).toString("base64")) // no assistant after → keeps base64
      await I.archiveUserMedia([a, b, asst, c], root)
      const sub = I.substituteArchivedAttachments([a, b, asst, c], root)
      assert.equal(sub[0].parts[0].type, "text") // assistant after ua → ref
      assert.match(String(sub[0].parts[0].text), /^\[attachment saved: \.hippocampus\/attachments\//)
      assert.equal(sub[1].parts[0].type, "text") // the same later assistant answers ub too (consecutive user turns)
      assert.equal(sub[3].parts[0].type, "file") // unanswered trailing turn keeps the real base64
    } finally {
      rmrf(root)
    }
  })
})

describe("stage-2: one-shot sticky-eviction reset after provider compaction", () => {
  it("resets exactly once when the counter changes, then goes sticky again; legacy path unchanged", () => {
    const big = "C".repeat(28000) // ~8k tokens per tool output → overflow at a 40k limit (cap 10k)
    const msgs: any[] = []
    for (const id of ["A", "B", "C"]) msgs.push(...mkUnit(id, `question ${id}`, `${big} SENTINEL_${id}`))

    // Phase 1 — pre-compaction: eviction kicks in; the caller stores evictedCount + compactionCount per session.
    const r1 = I.buildWindow(msgs, "ses_c23", 40000)
    assert.ok(r1.stats.evictedCount > 0, "baseline must evict")
    assert.equal(r1.stats.compactionCount, 0)

    // Phase 2 — the provider compacts: history is replaced by a marker unit + small recent turns.
    const compacted: any[] = [
      { info: { id: "m_comp", role: "user", time: { created: 1, completed: 1 } }, parts: [{ id: "p_comp", type: "text", text: "[provider compaction]\nsummary of the evicted turns" }] },
      ...mkUnit("D", "question D", "small answer"),
    ]

    // Counter changed (0 → 1): prevEvict must be ignored — one-shot reset.
    const r2 = I.buildWindow(compacted, "ses_c23", 40000, undefined, undefined, undefined, undefined, r1.stats.evictedCount, 0)
    assert.equal(r2.stats.compactionCount, 1)
    assert.equal(r2.stats.evictedCount, 0, "reset: small post-compaction history fits without eviction")

    // Counter unchanged (1 → 1): sticky behavior returns — a stale high prevEvict is honored.
    const maxEvict = I.unitize(compacted).length - 1 // evict everything except the last unit
    const r3 = I.buildWindow(compacted, "ses_c23", 40000, undefined, undefined, undefined, undefined, maxEvict, 1)
    assert.equal(r3.stats.evictedCount, maxEvict, "equal counter → prevEvict applies again (sticky)")

    // Marker-accumulating history (v1-style: both summaries stay visible) — counter 1 → 2 resets once more.
    const compactedAccum: any[] = [
      { info: { id: "m_comp", role: "user", time: { created: 1, completed: 1 } }, parts: [{ id: "p_comp", type: "text", text: "[provider compaction]\nfirst summary" }] },
      { info: { id: "m_comp2", role: "user", time: { created: 1, completed: 1 } }, parts: [{ id: "p_comp2", type: "text", text: "[provider compaction]\nsecond summary" }] },
      ...mkUnit("E", "question E", "small answer"),
    ]
    const r4 = I.buildWindow(compactedAccum, "ses_c23", 40000, undefined, undefined, undefined, undefined, maxEvict, 1)
    assert.equal(r4.stats.compactionCount, 2)
    assert.equal(r4.stats.evictedCount, 0, "counter increment resets sticky eviction again")

    // opencode v2 reality: the history loader exposes only the LATEST completed compaction (core/src/session/history.ts reads from its seq on), so a second compaction keeps the count at 1 → no reset.
    // Documented limitation of the counter design — superseded by stage-3 head tracking in the describe block below; here we pin the legacy counter-mode behavior.
    const compactedV2 = [
      { info: { id: "m_comp2", role: "user", time: { created: 1, completed: 1 } }, parts: [{ id: "p_comp2", type: "text", text: "[provider compaction]\nsecond summary" }] },
      ...mkUnit("E", "question E", "small answer"),
    ]
    const r4b = I.buildWindow(compactedV2, "ses_c23", 40000, undefined, undefined, undefined, undefined, maxEvict, 1)
    assert.equal(r4b.stats.compactionCount, 1)
    assert.equal(r4b.stats.evictedCount, Math.min(maxEvict, I.unitize(compactedV2).length - 1), "unchanged counter → stale prevEvict honored (sticky)")

    // Legacy path (no prevCompactionCount): any marker in history still resets — bit-for-bit old behavior.
    const r5 = I.buildWindow(compacted, "ses_c23", 40000, undefined, undefined, undefined, undefined, maxEvict)
    assert.equal(r5.stats.evictedCount, 0, "legacy hasCompaction reset preserved when the parameter is omitted")
  })
})

describe("stage-3: compaction detection via history-head tracking", () => {
  const big = "C".repeat(28000) // ~8k tokens per tool output → overflow at a 40k limit (cap 8k, target 5.6k)
  function markerMsg(id: string, summary: string): any {
    return { info: { id, role: "user", time: { created: 1, completed: 1 } }, parts: [{ id: `p_${id}`, type: "text", text: `[provider compaction]\n${summary}` }] }
  }

  it("first compaction: head replaced → sticky eviction resets to zero", () => {
    const msgs: any[] = []
    for (const id of ["A", "B", "C"]) msgs.push(...mkUnit(id, `question ${id}`, `${big} SENTINEL_${id}`))
    const r1 = I.buildWindow(msgs, "ses_h3a", 40000) // first observation: the hook has no state yet
    assert.ok(r1.stats.evictedCount > 0, "baseline must evict")
    // The hook persists { firstId, units, evicted } from stats per session.
    const state = { firstId: r1.stats.firstId, units: r1.stats.units, evicted: r1.stats.evictedCount }
    assert.equal(state.firstId, "u_A")

    // Provider compaction: the v2 loader now exposes only [marker] + recent turns — a different head.
    const compacted = [markerMsg("m_comp", "summary of the evicted turns"), ...mkUnit("D", "question D", "small answer")]
    const r2 = I.buildWindow(compacted, "ses_h3a", 40000, undefined, undefined, undefined, undefined, undefined, undefined, state)
    assert.equal(r2.stats.firstId, "m_comp")
    assert.equal(r2.stats.units, 2)
    assert.equal(r2.stats.evictedCount, 0, "head changed → one-shot reset; small post-compaction history fits without eviction")
  })

  it("second compaction with unchanged marker count (v2 loader): detected via head id", () => {
    // Pre-compaction: eviction is active.
    const msgs: any[] = []
    for (const id of ["A", "B", "C"]) msgs.push(...mkUnit(id, `question ${id}`, `${big} SENTINEL_${id}`))
    const r1 = I.buildWindow(msgs, "ses_h3b", 40000)
    assert.ok(r1.stats.evictedCount > 0)

    // First compaction: [marker] + two big recent turns → eviction stays active on the new head.
    const h1 = [markerMsg("m_comp", "first summary"), ...mkUnit("D", "question D", `${big} SENTINEL_D`), ...mkUnit("E", "question E", `${big} SENTINEL_E`)]
    const r2 = I.buildWindow(h1, "ses_h3b", 40000, undefined, undefined, undefined, undefined, undefined, undefined, { firstId: r1.stats.firstId, units: r1.stats.units, evicted: r1.stats.evictedCount })
    assert.ok(r2.stats.evictedCount >= 1, "post-compaction history still overflows → eviction active again")

    // Second compaction: the v2 loader exposes only the LATEST marker — the marker count is unchanged (1 → 1), so the stage-2 counter design never resets here. Head tracking sees m_comp → m_comp2 and must reset despite the stale evicted > 0.
    const h2 = [markerMsg("m_comp2", "second summary"), ...mkUnit("F", "question F", "small answer")]
    const r3 = I.buildWindow(h2, "ses_h3b", 40000, undefined, undefined, undefined, undefined, undefined, undefined, { firstId: r2.stats.firstId, units: r2.stats.units, evicted: r2.stats.evictedCount })
    assert.equal(r3.stats.firstId, "m_comp2")
    assert.equal(r3.stats.units, 2)
    assert.equal(r3.stats.evictedCount, 0, "head id changed → reset even though the marker count stayed at 1 and prev.evicted was stale-high")
  })

  it("head replacement at the same unit length resets; appends do not", () => {
    const bigs: any[] = []
    for (const id of ["X", "Y", "Z"]) bigs.push(...mkUnit(id, `question ${id}`, `${big} SENTINEL_${id}`))
    const r1 = I.buildWindow(bigs, "ses_h3c", 40000)
    assert.ok(r1.stats.evictedCount > 0)

    // Same unit count (3), entirely different head: fresh computation must start from zero — the small+small+medium history fits under the cap.
    const replaced = [...mkUnit("P", "question P", "small answer"), ...mkUnit("Q", "question Q", "small answer"), ...mkUnit("R", "question R", "C".repeat(24000))]
    assert.equal(I.unitize(replaced).length, I.unitize(bigs).length)
    const r2 = I.buildWindow(replaced, "ses_h3c", 40000, undefined, undefined, undefined, undefined, undefined, undefined, { firstId: r1.stats.firstId, units: r1.stats.units, evicted: r1.stats.evictedCount })
    assert.equal(r2.stats.evictedCount, 0, "head replaced at the same length → reset; fresh fit check wins over the stale prevEvict")

    // Append to the original history (head unchanged, unit count grew): sticky eviction must keep applying.
    const appended = [...bigs, ...mkUnit("W", "question W", "small answer")]
    const r3 = I.buildWindow(appended, "ses_h3c", 40000, undefined, undefined, undefined, undefined, undefined, undefined, { firstId: r1.stats.firstId, units: r1.stats.units, evicted: r1.stats.evictedCount })
    assert.ok(r3.stats.evictedCount >= r1.stats.evictedCount, "append is not a head change → sticky prevEvict honored")
  })

  it("history shortening with the same head resets", () => {
    const msgs: any[] = []
    for (const id of ["A", "B", "C"]) msgs.push(...mkUnit(id, `question ${id}`, `${big} SENTINEL_${id}`))
    const r1 = I.buildWindow(msgs, "ses_h3d", 40000)
    assert.ok(r1.stats.evictedCount > 0)

    // Same head (u_A), fewer units: the shrink alone must trigger the reset.
    const shortened = [...mkUnit("A", "question A", "small answer"), ...mkUnit("B", "question B", "small answer")]
    assert.equal(shortened[0].info.id, msgs[0].info.id)
    const r2 = I.buildWindow(shortened, "ses_h3d", 40000, undefined, undefined, undefined, undefined, undefined, undefined, { firstId: r1.stats.firstId, units: r1.stats.units, evicted: r1.stats.evictedCount })
    assert.equal(r2.stats.firstId, "u_A")
    assert.equal(r2.stats.units, 2)
    assert.equal(r2.stats.evictedCount, 0, "units.length < prev.units → reset even though the head id is unchanged")
  })

  it("captures expired, total < cap, same head → NO reset (sticky eviction persists)", () => {
    // Stored outputs are tiny; the captures map carries the full tool outputs (what a live session has before the 10-min expiry).
    const msgs: any[] = []
    for (const id of ["A", "B", "C"]) msgs.push(...mkUnit(id, `question ${id}`, "small answer"))
    const captures = new Map<string, string>([["c_A", big], ["c_B", big], ["c_C", big]])

    // First observation with live captures: the full outputs overflow → eviction kicks in.
    const r1 = I.buildWindow(msgs, "ses_h3e", 40000, undefined, captures)
    assert.ok(r1.stats.evictedCount > 0, "live captures must push the window over the cap")

    // Captures expire (the hook drops them after 10 min idle): same head, same unit count, total now fits under the cap.
    const r2 = I.buildWindow(msgs, "ses_h3e", 40000, undefined, undefined, undefined, undefined, undefined, undefined, { firstId: r1.stats.firstId, units: r1.stats.units, evicted: r1.stats.evictedCount })
    assert.ok(r2.stats.totalTokens <= r2.stats.capTokens)
    assert.equal(r2.stats.evictedCount, r1.stats.evictedCount, "no head change and no shrink → sticky eviction persists even though the total now fits (an unconditional 'fits under cap' reset would break prompt-cache stability)")
  })
})

// ---------- stage-1 finishing: correctness round (items 0–6) ----------

describe("item 0.1: taintGuard removed — refusal is unconditional", () => {
  it("key is gone from DEFAULT_CONFIG and loadConfig ignores it; taint state still blocks", async () => {
    const wt = freshRoot()
    try {
      assert.equal((I.DEFAULT_CONFIG as any).taintGuard, undefined, "no taintGuard in defaults")
      fs.mkdirSync(path.join(wt, ".hippocampus"), { recursive: true })
      // A user config that tries to disable the (removed) guard must have no effect surface at all.
      fs.writeFileSync(path.join(wt, ".hippocampus", "hippocampus.json"), JSON.stringify({ taintGuard: false }))
      const cfg = await I.loadConfig(wt)
      assert.equal((cfg as any).taintGuard, undefined, "loadConfig must not pick up the removed key")
      // The guard itself stays unconditional: a tainted session is recognized.
      I.taintedBySession.set("s_tg", true)
      try {
        assert.equal(I.isTainted("s_tg"), true)
        assert.equal(I.isTainted(""), false, "unknown sid never blocks")
      } finally {
        I.taintedBySession.delete("s_tg")
      }
    } finally {
      rmrf(wt)
    }
  })
})

describe("item 0.2: wiki-walk cap log — explicit worktree, error level", () => {
  it("cap hit writes an ERROR line under the PASSED worktree (no basename guessing)", async () => {
    const wt = freshRoot() // project that must receive the log
    const other = freshRoot() // where the oversized wiki actually lives
    try {
      fs.mkdirSync(path.join(other, ".hippocampus", "wiki"), { recursive: true })
      // Two pages: the first (huge) one always loads and exhausts the byte budget; the second is what trips the cap.
      fs.writeFileSync(path.join(other, ".hippocampus", "wiki", "a-big.md"), `---\ntitle: Big\n---\n` + "x".repeat(I.WIKI_WALK_MAX_BODY_BYTES + 1024 * 1024))
      fs.writeFileSync(path.join(other, ".hippocampus", "wiki", "b-small.md"), `---\ntitle: Small\n---\nhello`)
      await I.ensureInit(wt)
      const pages = await I.wikiList(path.join(other, ".hippocampus"), wt)
      assert.equal(pages.length, 1, "first page always loads; the second is skipped by the cap")
      const day = new Date().toISOString().slice(0, 10)
      const logFile = path.join(wt, ".hippocampus", "logs", `${day}.log`)
      assert.ok(fs.existsSync(logFile), "log written to the passed worktree")
      assert.match(fs.readFileSync(logFile, "utf8"), /ERROR\s+\[wiki-walk\]/)
      // Must NOT be attributed to the wiki's own project via basename guessing.
      const otherLog = path.join(other, ".hippocampus", "logs", `${day}.log`)
      assert.ok(!fs.existsSync(otherLog) || !/wiki-walk/.test(fs.readFileSync(otherLog, "utf8")), "no log under the wiki root")
    } finally {
      rmrf(wt); rmrf(other)
    }
  })
})

describe("item 0.3: escape/unescape archive line round-trip", () => {
  it("structural lines survive escape→unescape; normal lines pass through untouched", () => {
    const structural = [
      `## u_abc123 · 19:25:45 · user→assistant×0 · ~35 tok · "hint"`,
      "### t_call-1 full output block",
      "<!-- m_msg_xyz -->",
    ]
    for (const line of structural) {
      const esc = I.escapeArchiveLine(line)
      assert.notEqual(esc, line, `must escape ${line.slice(0, 24)}…`)
      assert.ok(esc.startsWith("\\"), "escaped line gains a leading backslash")
      assert.equal(I.unescapeArchiveLine(esc), line, "round-trip restores the original")
    }
    for (const line of ["hello world", "##not-a-header", "<!-- comment -->", "\\hello"]) {
      assert.equal(I.escapeArchiveLine(line), line, `normal line untouched: ${line}`)
      assert.equal(I.unescapeArchiveLine(line), line, `normal line passes through: ${line}`)
    }
    // The inverse strips exactly one leading backslash before a structural prefix (the "\\(" group in the unescape regex).
    assert.equal(I.unescapeArchiveLine("\\## u_x"), "## u_x")
    assert.equal(I.unescapeArchiveLine("\\### t_x"), "### t_x")
    assert.equal(I.unescapeArchiveLine("\\<!-- m_x -->"), "<!-- m_x -->")
  })
})

describe("item 1: core-memory bare HUMAN → ## HUMAN migration", () => {
  it("migrates the exact case (bare HUMAN inside PERSONA), idempotent, never touches other shapes", async () => {
    const wt = freshRoot()
    try {
      fs.mkdirSync(path.join(wt, ".hippocampus"), { recursive: true })
      const cmFile = path.join(wt, ".hippocampus", "core-memory.md")
      fs.writeFileSync(cmFile, "## PERSONA\nI am careful.\nHUMAN\nuser is terse\n")
      I.applyLogLevel(wt, "info") // the migration logs at info; make it visible for the assertion below
      await I.ensureInit(wt)
      let cm = fs.readFileSync(cmFile, "utf8")
      assert.ok(cm.includes("## HUMAN"), "header created")
      assert.ok(!/^HUMAN$/m.test(cm), "bare line gone")
      assert.ok(cm.includes("user is terse"), "following content preserved")
      const day = new Date().toISOString().slice(0, 10)
      assert.match(fs.readFileSync(path.join(wt, ".hippocampus", "logs", `${day}.log`), "utf8"), /INFO\s+\[core-memory\].*migrated/)

      // Idempotent: a second migration on the already-migrated file is a no-op.
      const before = fs.readFileSync(cmFile, "utf8")
      assert.equal((await I.migrateCoreMemoryHumanBlock(wt)).changed, false)
      assert.equal(fs.readFileSync(cmFile, "utf8"), before)

      // Already-correct header → untouched.
      fs.writeFileSync(cmFile, "## PERSONA\nx\n\n## HUMAN\ny\n")
      assert.equal((await I.migrateCoreMemoryHumanBlock(wt)).changed, false)
      assert.equal(fs.readFileSync(cmFile, "utf8"), "## PERSONA\nx\n\n## HUMAN\ny\n")

      // No PERSONA block → not this exact case, file untouched.
      fs.writeFileSync(cmFile, "HUMAN\njust a word somewhere\n")
      assert.equal((await I.migrateCoreMemoryHumanBlock(wt)).changed, false)
      assert.equal(fs.readFileSync(cmFile, "utf8"), "HUMAN\njust a word somewhere\n")
    } finally {
      rmrf(wt)
    }
  })
})

describe("item 2: attachments isolated per project root", () => {
  it("a hash archived under root A never drives substitution under root B", async () => {
    const a = freshRoot()
    const b = freshRoot()
    try {
      const b64 = Buffer.from(`iso-${Date.now()}-${Math.random()}`).toString("base64")
      const msg = mkImageMsg("u_iso", b64)
      const asst: any = { info: { id: "a_iso", role: "assistant" }, parts: [{ type: "text", text: "ok" }] }
      await I.archiveUserMedia([msg, asst], a)
      const hash = I.attachmentHash(msg.parts[0].url)
      assert.ok(fs.existsSync(path.join(I.hippoRoot(a), "attachments", `${hash}.png`)), "archived under A")

      // Under B the file does not exist → substitution must NOT emit a dangling ref.
      const subB = I.substituteArchivedAttachments([msg, asst], b)
      assert.equal(subB[0].parts[0].type, "file", "base64 kept under the foreign root")

      // Under A it is substituted to the short ref.
      const subA = I.substituteArchivedAttachments([msg, asst], a)
      assert.equal(subA[0].parts[0].type, "text")
      assert.match(String(subA[0].parts[0].text), /^\[attachment saved: \.hippocampus\/attachments\//)

      // Re-archiving under A stays idempotent (per-root dedup set hit).
      await I.archiveUserMedia([msg, asst], a)
    } finally {
      rmrf(a); rmrf(b)
    }
  })
})

describe("item 3: addToGitignore=false leaves .gitignore untouched", () => {
  it("ensureInit with cfg.addToGitignore=false does not modify an existing .gitignore", async () => {
    const wt = freshRoot()
    try {
      fs.writeFileSync(path.join(wt, ".gitignore"), "node_modules\n")
      await I.ensureInit(wt, { ...I.DEFAULT_CONFIG, addToGitignore: false })
      assert.equal(fs.readFileSync(path.join(wt, ".gitignore"), "utf8"), "node_modules\n", "no hippo lines added")
    } finally {
      rmrf(wt)
    }
  })
  it("default behavior (no cfg / addToGitignore=true) still adds the hippocampus lines", async () => {
    const wt = freshRoot()
    try {
      await I.ensureInit(wt)
      assert.ok(fs.readFileSync(path.join(wt, ".gitignore"), "utf8").includes(".hippocampus/raw/"))
    } finally {
      rmrf(wt)
    }
  })
})

describe("item 4: logEvent thunks + level gate", () => {
  it("thunk is not evaluated below the threshold, evaluated and written above it; isLogEnabled agrees", async () => {
    const wt = freshRoot()
    try {
      await I.ensureInit(wt)
      let calls = 0
      await I.logEvent(wt, "debug", "thunk-test", () => { calls++; return "payload" })
      assert.equal(calls, 0, "below-threshold debug must not build the message")
      const logFile = path.join(wt, ".hippocampus", "logs", `${new Date().toISOString().slice(0, 10)}.log`)
      assert.ok(!fs.existsSync(logFile) || !fs.readFileSync(logFile, "utf8").includes("payload"))

      I.applyLogLevel(wt, "trace")
      await I.logEvent(wt, "debug", "thunk-test", () => { calls++; return "payload" })
      assert.equal(calls, 1, "above threshold the thunk is evaluated once")
      assert.ok(fs.readFileSync(logFile, "utf8").includes("payload"))

      assert.equal(I.isLogEnabled(wt, "debug"), true)
      I.applyLogLevel(wt, "error")
      assert.equal(I.isLogEnabled(wt, "debug"), false)
    } finally {
      rmrf(wt)
    }
  })
})

describe("item 5: captureMaxItemBytes per-item cap", () => {
  it("putCapture truncates a single item to the per-item cap (below the session budget)", () => {
    I.putCapture("s_item", "c1", "x".repeat(200), 1048576, 500, 8, 50)
    assert.equal(I.capturesBySession.get("s_item").m.get("c1")!.length, 50)
    // No explicit item cap → old behavior: truncate to the session budget only.
    I.putCapture("s_legacy", "c2", "y".repeat(200), 1048576, 500, 8)
    assert.equal(I.capturesBySession.get("s_legacy").m.get("c2")!.length, 200)
  })
  it("loadConfig derives the item cap as captureMaxBytes/8 clamped to [65536, captureMaxBytes]", async () => {
    const wt = freshRoot()
    try {
      fs.mkdirSync(path.join(wt, ".hippocampus"), { recursive: true })
      const cfgFile = path.join(wt, ".hippocampus", "hippocampus.json")
      const write = (obj: object) => fs.writeFileSync(cfgFile, JSON.stringify(obj))

      write({})
      let cfg = await I.loadConfig(wt)
      assert.equal(cfg.captureMaxItemBytes, Math.floor(cfg.captureMaxBytes / 8), "default = budget/8")

      write({ captureMaxBytes: 16 * 1024 * 1024 })
      cfg = await I.loadConfig(wt)
      assert.equal(cfg.captureMaxItemBytes, 2 * 1024 * 1024, "re-derived from the custom budget")

      write({ captureMaxItemBytes: 8192 }) // below the floor → clamped up to 65536
      cfg = await I.loadConfig(wt)
      assert.equal(cfg.captureMaxItemBytes, 65536)

      write({ captureMaxBytes: 1024 * 1024, captureMaxItemBytes: 999 * 1024 * 1024 }) // above the budget → clamped down
      cfg = await I.loadConfig(wt)
      assert.equal(cfg.captureMaxItemBytes, 1024 * 1024, "never exceeds captureMaxBytes")

      write({ captureMaxBytes: 8192 }) // tiny budget below the floor: the cap itself becomes the item limit (min(65536, cap))
      cfg = await I.loadConfig(wt)
      assert.equal(cfg.captureMaxItemBytes, 8192)
    } finally {
      rmrf(wt)
    }
  })
})

describe("item 6: idle flush writes ALL messages of the last unit", () => {
  it("finished:true archives every held assistant of the last unit (not just the final one), idempotently", async () => {
    const wt = freshRoot()
    try {
      const sid = "s_flush6"
      // Last unit: user + TWO incomplete assistants (a retried/streamed pair). unitize keeps them in one unit.
      const u1: any = { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "q" }] }
      const a1: any = { info: { id: "a1", role: "assistant" }, parts: [{ type: "text", text: "first attempt" }] } // no time.completed → incomplete
      const a2: any = { info: { id: "a2", role: "assistant" }, parts: [{ type: "text", text: "second attempt" }] } // no time.completed → incomplete, and the last message

      const log = I.getSessionLog(wt, sid)
      let n = await log.writeUnits([u1, a1, a2], {})
      assert.equal(n, 1, "only the user part lands before finished")
      let raw = fs.readFileSync(I.sessionFilePath(wt, sid), "utf8")
      assert.ok(raw.includes("<!-- m_u1 -->"))
      assert.ok(!raw.includes("<!-- m_a1 -->"), "incomplete assistants held back")

      n = await log.writeUnits([u1, a1, a2], { finished: true })
      assert.equal(n, 1, "one unit chunk on the idle flush")
      raw = fs.readFileSync(I.sessionFilePath(wt, sid), "utf8")
      assert.ok(raw.includes("<!-- m_a1 -->"), "first assistant archived too (old code wrote only a2)")
      assert.ok(raw.includes("<!-- m_a2 -->"))

      // Idempotent: the written-guard covers all m.info.id of the unit → nothing new.
      n = await log.writeUnits([u1, a1, a2], { finished: true })
      assert.equal(n, 0)
      I.deleteSessionState?.(wt, sid)
    } finally {
      rmrf(wt)
    }
  })
})

// ---------- stage-1 finishing, second half (items 6b–11) ----------

function readLogLine(root: string): string {
  try {
    return fs.readFileSync(path.join(I.hippoRoot(root), "logs", `${new Date().toISOString().slice(0, 10)}.log`), "utf8")
  } catch {
    return ""
  }
}

async function waitFor(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`waitFor timeout: ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

// Minimal fake opencode plugin context for items 7/10: the surface setup() actually touches
// (location/session/event/tool/command/model), with a controllable event stream. Session hooks are
// captured and invoked directly — that is how core calls them too. close() MUST be called in finally:
// while open, the event loop polls the queue and would hold the test process alive.
async function fakePluginCtx(directory: string) {
  const mod = await import("../hippocampus/hippocampus.ts")
  const sessionHooks = new Map<string, (ev: any) => Promise<void>>()
  const toolHooks = new Map<string, (ev: any) => Promise<void>>()
  const queue: any[] = []
  let closed = false
  const stream: AsyncIterable<any> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<any>> {
          while (queue.length === 0 && !closed) await new Promise((r) => setTimeout(r, 2))
          if (queue.length > 0) return { value: queue.shift() as any, done: false }
          return { value: undefined as any, done: true }
        },
      }
    },
  }
  const ctx = {
    location: { directory },
    session: {
      get: async (_q: any) => ({ location: { directory } }),
      hook: (name: string, fn: any) => void sessionHooks.set(name, fn),
    },
    event: { subscribe: () => stream },
    tool: { transform: async (fn: any) => fn({ add: (_t: any) => {} }), hook: (n: string, f: any) => void toolHooks.set(n, f) }, // capture execute.after so tests can invoke it directly with crafted events
    command: { transform: async (fn: any) => fn({ add: (_c: any) => {} }) },
    model: { list: async () => ({ data: [] }) },
  }
  await mod.default.setup(ctx as any)
  return {
    sessionHooks,
    toolHooks,
    emit: (ev: any) => void queue.push(ev),
    close: () => { closed = true },
  }
}

describe("item 6b: no named exports from the plugin file", () => {
  it("only a default export exists (loader-safe); isLogEnabled stays reachable via internals", async () => {
    const mod = await import("../hippocampus/hippocampus.ts")
    assert.deepEqual(Object.keys(mod).filter((k) => k !== "default"), [], `unexpected named exports: ${Object.keys(mod)}`)
    assert.equal(typeof (mod as any).isLogEnabled, "undefined", "a named export would be invoked by the loader with an input object → TypeError in path.resolve")
    assert.equal(typeof I.isLogEnabled, "function", "the function itself remains available via __hippoInternals for tests")
  })
})

describe("item 7: unexpected errors are visible under the default logLevel=error", () => {
  it("default level stays error (DEFAULT_CONFIG and loadConfig)", async () => {
    const wt = freshRoot()
    try {
      assert.equal(I.DEFAULT_CONFIG.logLevel, "error")
      assert.equal((await I.loadConfig(wt)).logLevel, "error")
    } finally {
      rmrf(wt)
    }
  })

  it("wiki-db: an unopenable index logs ERROR [wiki-db] into the passed worktree", async () => {
    const wt = freshRoot()
    try {
      fs.mkdirSync(path.join(I.hippoRoot(wt), "wiki", "index.db"), { recursive: true }) // a DIRECTORY where the db file must be → open fails hard
      await I.rebuildWikiIndex(I.hippoRoot(wt), wt) // first arg is the hippo root (.hippocampus), second the worktree for log attribution
      await waitFor(() => readLogLine(wt).includes("[wiki-db]"), "ERROR [wiki-db] line") // openWikiDb logs fire-and-forget
      assert.match(readLogLine(wt), /ERROR \[wiki-db\]/)
    } finally {
      rmrf(wt)
    }
  })

  it("expected miss (indexWikiPage on a vanished page) is silent at default level, visible at debug", async () => {
    const wt = freshRoot()
    try {
      await I.ensureInit(wt) // wiki/ must exist so openWikiDb succeeds and the miss path (not the open failure) is reached
      await I.indexWikiPage(I.hippoRoot(wt), "no-such-page.md", wt) // first arg is the hippo root, not the worktree — with a wrong root openWikiDb fails silently before the miss path
      assert.equal(readLogLine(wt), "", "expected miss must not produce an ERROR line under the default level")
      fs.writeFileSync(path.join(I.hippoRoot(wt), "hippocampus.json"), JSON.stringify({ logLevel: "debug" }))
      I.applyLogLevel(wt, (await I.loadConfig(wt)).logLevel) // same keying production uses (cfgFor(worktree))
      await I.indexWikiPage(I.hippoRoot(wt), "no-such-page.md", wt)
      await waitFor(() => readLogLine(wt).includes("DEBUG [hippocampus]"), "DEBUG line for the expected miss")
    } finally {
      rmrf(wt)
    }
  })

  it("context hook: ensureInit failure logs ERROR [ensure-init] into the session's project (fake ctx)", async () => {
    const wt = freshRoot()
    try {
      fs.mkdirSync(path.join(wt, ".hippocampus"), { recursive: true })
      fs.writeFileSync(path.join(wt, ".hippocampus", "memfs"), "blocker") // memfs is a FILE → mkdir(memfs/archive) throws inside ensureInit
      const fx = await fakePluginCtx(wt)
      try {
        const ev: any = { sessionID: "s7a", system: [], messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] }
        await fx.sessionHooks.get("context")!(ev) // must not throw out of the hook (inner catch logs and continues)
      } finally {
        fx.close()
      }
      assert.match(readLogLine(wt), /ERROR \[ensure-init\]/) // awaited inside the hook → deterministic after the await
    } finally {
      rmrf(wt)
    }
  })

  it("event handler: a failing recallAppend logs ERROR [event-handler] into the event's project (fake ctx)", async () => {
    const wt = freshRoot()
    try {
      fs.mkdirSync(path.join(wt, ".hippocampus"), { recursive: true })
      fs.writeFileSync(path.join(wt, ".hippocampus", "recall"), "blocker") // recall is a FILE → mkdir(recursive) in recallAppend throws
      const fx = await fakePluginCtx(wt)
      try {
        fx.emit({ type: "session.text.ended", data: { sessionID: "s7b", text: "hi" } })
        await waitFor(() => readLogLine(wt).includes("[event-handler]"), "ERROR [event-handler] line") // handler logs fire-and-forget
      } finally {
        fx.close()
      }
    } finally {
      rmrf(wt)
    }
  })

  it("healthy context call under the fake ctx: no ERROR lines, messages spliced in place (integration)", async () => {
    const wt = freshRoot()
    try {
      const fx = await fakePluginCtx(wt)
      try {
        const ev: any = { sessionID: "s7c", system: [], messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] }
        await fx.sessionHooks.get("context")!(ev)
        assert.ok(Array.isArray(ev.messages), "hook must splice event.messages in place")
        assert.ok(fs.existsSync(I.sessionFilePath(wt, "s7c")), "raw archive written for the session (offload path ran end-to-end)")
      } finally {
        fx.close()
      }
      assert.equal(readLogLine(wt), "", "a healthy run leaves no error lines under the default level")
    } finally {
      rmrf(wt)
    }
  })
})

describe("item 8: wiki tree limits (maxWikiPages / maxWikiTotalBytes)", () => {
  it("defaults and validation: 500 pages / 8MiB, values must be > 0", async () => {
    const wt = freshRoot()
    try {
      assert.equal(I.DEFAULT_CONFIG.maxWikiPages, 500)
      assert.equal(I.DEFAULT_CONFIG.maxWikiTotalBytes, 8 * 1024 * 1024)
      fs.mkdirSync(I.hippoRoot(wt), { recursive: true })
      fs.writeFileSync(path.join(I.hippoRoot(wt), "hippocampus.json"), JSON.stringify({ maxWikiPages: 7, maxWikiTotalBytes: 4096 }))
      const cfg = await I.loadConfig(wt)
      assert.equal(cfg.maxWikiPages, 7)
      assert.equal(cfg.maxWikiTotalBytes, 4096)
      fs.writeFileSync(path.join(I.hippoRoot(wt), "hippocampus.json"), JSON.stringify({ maxWikiPages: 0, maxWikiTotalBytes: -1 }))
      const cfg2 = await I.loadConfig(wt)
      assert.equal(cfg2.maxWikiPages, 500, "invalid value falls back to the default")
      assert.equal(cfg2.maxWikiTotalBytes, 8 * 1024 * 1024)
    } finally {
      rmrf(wt)
    }
  })

  it("wikiWriteFile and memfsWrite refuse archive/ (cold storage is consolidation-managed)", async () => {
    const wt = freshRoot()
    try {
      await I.ensureInit(wt)
      // First arg is the HIPPO ROOT (.hippocampus), same as consolidate's call site — with a bare worktree the write would target <wt>/wiki/ instead.
      assert.match((await I.wikiWriteFile(I.hippoRoot(wt), "archive/x.md", "body")).error ?? "", /refused/)
      assert.equal(fs.existsSync(path.join(I.hippoRoot(wt), "wiki", "archive", "x.md")), false)
      assert.match((await I.memfsWrite(wt, "archive/note.md", "body")).error ?? "", /refused/)
    } finally {
      rmrf(wt)
    }
  })

  it("page limit refuses new pages; overwrite is accounted at the NEW size (old subtracted)", async () => {
    const wt = freshRoot()
    try {
      await I.ensureInit(wt)
      // First arg is the HIPPO ROOT (same as every plugin call site): with a bare worktree these writes would land in <wt>/wiki/ and the disk assertions below would check the wrong place.
      assert.equal((await I.wikiWriteFile(I.hippoRoot(wt), "a.md", "x".repeat(10), { maxPages: 1 })).error, undefined)
      assert.match((await I.wikiWriteFile(I.hippoRoot(wt), "b.md", "y".repeat(10), { maxPages: 1 })).error ?? "", /page limit/)
      assert.equal(fs.existsSync(path.join(I.hippoRoot(wt), "wiki", "b.md")), false, "refused write must not touch disk")
      assert.equal((await I.wikiWriteFile(I.hippoRoot(wt), "a.md", "x".repeat(50), { maxPages: 1 })).error, undefined, "overwriting the existing page does not grow the count")

      const wb = freshRoot()
      try {
        await I.ensureInit(wb)
        const limit = 100
        assert.equal((await I.wikiWriteFile(I.hippoRoot(wb), "p.md", "a".repeat(60), { maxTotalBytes: limit })).error, undefined)
        // new size (85) alone fits under the limit; without subtracting the old 60 the total would be 145 > 100 and wrongly refused.
        assert.equal((await I.wikiWriteFile(I.hippoRoot(wb), "p.md", "b".repeat(85), { maxTotalBytes: limit })).error, undefined, "overwrite accounted as bytes - existingSize + newSize")
        assert.match((await I.wikiWriteFile(I.hippoRoot(wb), "q.md", "c".repeat(30), { maxTotalBytes: limit })).error ?? "", /size limit/)
      } finally {
        rmrf(wb)
      }
    } finally {
      rmrf(wt)
    }
  })

  it("consolidate passes the limits explicitly: an SOP draft beyond maxWikiPages is skipped, not written", async () => {
    const wt = freshRoot()
    try {
      await I.ensureInit(wt)
      fs.mkdirSync(I.hippoRoot(wt), { recursive: true })
      fs.writeFileSync(path.join(I.hippoRoot(wt), "hippocampus.json"), JSON.stringify({ maxWikiPages: 2 }))
      const wikiDir = path.join(I.hippoRoot(wt), "wiki")
      // Two active pages → the tree is already at the page budget.
      fs.writeFileSync(path.join(wikiDir, "p1.md"), "---\ntitle: P1\n---\nbody one\n")
      fs.writeFileSync(path.join(wikiDir, "p2.md"), "---\ntitle: P2\n---\nbody two\n")
      // The same 3-tool sequence in TWO sessions → extractSopCandidates proposes skills/shell-read-edit.md (a NEW page).
      const gram = "[tool shell call args={}]\n[tool read call args={}]\n[tool edit call args={}]\n"
      fs.mkdirSync(path.join(I.hippoRoot(wt), "raw"), { recursive: true })
      for (const s of ["ses_a", "ses_b"]) fs.writeFileSync(path.join(I.hippoRoot(wt), "raw", `${s}.md`), gram)
      const cfg = await I.loadConfig(wt)
      assert.equal(cfg.maxWikiPages, 2)
      const report = await I.consolidate(wt, cfg)
      assert.match(report, /sop: skipped skills\/shell-read-edit\.md/, `report was:\n${report}`)
      assert.match(report, /page limit/, "the refusal reason must surface in the report")
      assert.equal(fs.existsSync(path.join(wikiDir, "skills", "shell-read-edit.md")), false, "refused draft must not land on disk")
    } finally {
      rmrf(wt)
    }
  })

  it("consolidate TTL moves still work: internal rename bypasses the write limits (archive/ is its lane)", async () => {
    const wt = freshRoot()
    try {
      await I.ensureInit(wt)
      const wikiDir = path.join(I.hippoRoot(wt), "wiki")
      fs.writeFileSync(path.join(wikiDir, "expired.md"), "---\ntitle: Expired\nvalid_until: 2020-01-01\n---\nold body\n")
      // maxWikiPages=1 while TWO pages exist: a limit-enforcing write path would refuse; the TTL rename must not be blocked by it.
      fs.writeFileSync(path.join(wikiDir, "fresh.md"), "---\ntitle: Fresh\n---\nnew body\n")
      const cfg = await I.loadConfig(wt) // defaults (500/8MiB) — then tighten to prove the move ignores write limits
      cfg.maxWikiPages = 1
      const report = await I.consolidate(wt, cfg)
      assert.match(report, /ttl: archived expired\.md/)
      assert.ok(fs.existsSync(path.join(wikiDir, "archive", "expired.md")), "TTL archive move must succeed under a tight page budget")
    } finally {
      rmrf(wt)
    }
  })
})

describe("item 9: extractSopCandidates streaming caps", () => {
  it("line cap: archives beyond SOP_SCAN_MAX_LINES are not scanned; post-cap gram missed, pre-cap gram found, debug log written", async () => {
    const wt = freshRoot()
    try {
      fs.mkdirSync(I.hippoRoot(wt), { recursive: true })
      fs.writeFileSync(path.join(I.hippoRoot(wt), "hippocampus.json"), JSON.stringify({ logLevel: "debug" }))
      I.applyLogLevel(wt, (await I.loadConfig(wt)).logLevel)
      const raw = path.join(I.hippoRoot(wt), "raw")
      fs.mkdirSync(raw, { recursive: true })
      // Two archives of exactly T lines each (T = cap/2 + 100): the total slightly EXCEEDS SOP_SCAN_MAX_LINES, so whichever is
      // scanned first is read in full and the second one is cut off BEFORE its trailing gram — deterministic under any readdir order.
      // The shared leading gram proves scanning ran at all. (Exactly cap/2 would stop the counter AT the limit: the break is `>`, not `>=`.)
      const T = I.SOP_SCAN_MAX_LINES / 2 + 100
      const head = ["[tool alpha call args={}]", "[tool beta call args={}]", "[tool gamma call args={}]"]
      const tail = ["[tool xray call args={}]", "[tool yankee call args={}]", "[tool zulu call args={}]"]
      for (const name of ["ses_l1.md", "ses_l2.md"]) {
        fs.writeFileSync(path.join(raw, name), [...head, ...Array.from({ length: T - 6 }, () => "[noise line]"), ...tail].join("\n") + "\n")
      }
      const out = await I.extractSopCandidates(wt)
      assert.ok(out.some((c: any) => c.tools.join("|") === "alpha|beta|gamma"), `pre-cap gram must be found in both sessions: ${JSON.stringify(out).slice(0, 300)}`)
      assert.ok(!out.some((c: any) => c.tools.includes("xray")), "post-cap trailing gram must NOT form a candidate (line cap cut the second archive short)")
      assert.match(readLogLine(wt), /DEBUG \[sop-scan\].*line cap/) // awaited inside extractSopCandidates → deterministic
    } finally {
      rmrf(wt)
    }
  })

  it("file cap: only the first SOP_SCAN_MAX_FILES archives are scanned; truncation is logged", async () => {
    const wt = freshRoot()
    try {
      fs.mkdirSync(I.hippoRoot(wt), { recursive: true })
      fs.writeFileSync(path.join(I.hippoRoot(wt), "hippocampus.json"), JSON.stringify({ logLevel: "debug" }))
      I.applyLogLevel(wt, (await I.loadConfig(wt)).logLevel)
      const raw = path.join(I.hippoRoot(wt), "raw")
      fs.mkdirSync(raw, { recursive: true })
      // SOP_SCAN_MAX_FILES + 1 archives; every file carries the filler gram. The cap drops exactly one file — the last in
      // readdir order (observed here, not assumed): put the sentinel gram on the last two files so after the drop it survives
      // in only ONE session and cannot form a candidate (without the cap it would).
      for (let i = 0; i < I.SOP_SCAN_MAX_FILES + 1; i++) {
        const n = String(i).padStart(3, "0")
        fs.writeFileSync(path.join(raw, `ses_${n}.md`), "[tool alpha call args={}]\n[tool beta call args={}]\n[tool gamma call args={}]")
      }
      const order = fs.readdirSync(raw) // same getdents order the plugin's readdir sees (directory unchanged between calls)
      for (const f of [order[order.length - 2], order[order.length - 1]]) {
        fs.appendFileSync(path.join(raw, f), "\n[tool sentry_a call args={}]\n[tool sentry_b call args={}]\n[tool sentry_c call args={}]")
      }
      const out = await I.extractSopCandidates(wt)
      assert.ok(out.some((c: any) => c.tools.join("|") === "alpha|beta|gamma"), `filler gram must survive the cap (still in >= 2 sessions): ${JSON.stringify(out).slice(0, 300)}`)
      assert.ok(!out.some((c: any) => c.tools.includes("sentry_a")), `sentinel must not form a candidate (the file-cap dropped one of its two sessions): ${JSON.stringify(out).slice(0, 300)}`)
      assert.match(readLogLine(wt), /DEBUG \[sop-scan\].*scanning only the first/) // awaited inside extractSopCandidates → deterministic
    } finally {
      rmrf(wt)
    }
  })
})

describe("item 10: eventChainBySession self-cleanup (no per-session leak)", () => {
  it("same-key events serialize in order and the chain entry is deleted once settled", async () => {
    const wt = freshRoot()
    try {
      const fx = await fakePluginCtx(wt)
      try {
        const sid = "s10a"
        // Two back-to-back events: the loop dispatches ev2 while ev1's handler is still in flight → only the chain serializes them.
        fx.emit({ type: "session.text.ended", data: { sessionID: sid, text: "first" } })
        fx.emit({ type: "session.text.ended", data: { sessionID: sid, text: "second" } })
        const recallFile = path.join(I.hippoRoot(wt), "recall", `${sid}.jsonl`)
        await waitFor(() => fs.existsSync(recallFile) && fs.readFileSync(recallFile, "utf8").trim().split("\n").length >= 2, "both recall lines")
        // The leak fix: once the tail of the chain resolves and is still the tail, the entry must be GONE (old code kept resolved promises forever).
        await waitFor(() => I.eventChainBySession.get(sid) === undefined, "chain entry cleanup")
        const lines = fs.readFileSync(recallFile, "utf8").trim().split("\n").map((l: string) => JSON.parse(l))
        assert.deepEqual(lines.map((e: any) => e.text), ["first", "second"], "per-session ordering must be preserved by the chain")
      } finally {
        fx.close()
      }
    } finally {
      rmrf(wt)
    }
  })

  it("different keys do not block each other; both entries clean up", async () => {
    const wt = freshRoot()
    try {
      const fx = await fakePluginCtx(wt)
      try {
        fx.emit({ type: "session.text.ended", data: { sessionID: "s10b1", text: "a" } })
        fx.emit({ type: "session.text.ended", data: { sessionID: "s10b2", text: "b" } })
        // Wait for BOTH recall files FIRST: an absent chain entry is also true before dispatch even starts, so cleanup must be checked only after the handlers ran (and both keys settled independently — neither blocked the other).
        const f1 = path.join(I.hippoRoot(wt), "recall", "s10b1.jsonl")
        const f2 = path.join(I.hippoRoot(wt), "recall", "s10b2.jsonl")
        await waitFor(() => fs.existsSync(f1) && fs.readFileSync(f1, "utf8").includes("a") && fs.existsSync(f2) && fs.readFileSync(f2, "utf8").includes("b"), "both recall files written (different keys must not block each other)")
        await waitFor(() => I.eventChainBySession.get("s10b1") === undefined && I.eventChainBySession.get("s10b2") === undefined, "both chain entries cleaned up")
      } finally {
        fx.close()
      }
    } finally {
      rmrf(wt)
    }
  })
})

describe("item 11: head tracking when v2 history has no m.id (deriveMsgID stability)", () => {
  const big = "C".repeat(28000) // ~8k tokens per tool output → overflow at a 40k limit (cap 8k, target 5.6k), same shape as the stage-3 suite

  function mkV2Unit(id: string, userText: string, output: string): any[] {
    return [
      { role: "user", content: [{ type: "text", text: userText }] }, // deliberately NO m.id
      { role: "assistant", content: [{ type: "tool-call", id: `c_${id}`, name: "shell", input: {} }, { type: "text", text: `done ${id}` }] },
      { role: "tool", content: [{ type: "tool-result", id: `c_${id}`, name: "shell", result: { type: "content", value: [{ type: "text", text: output }] } }] },
    ]
  }

  it("core re-feeds the full append-only history without ids: firstId stable, sticky eviction holds (no false reset)", () => {
    const v2msgs: any[] = []
    for (const id of ["A", "B", "C"]) v2msgs.push(...mkV2Unit(id, `question ${id}`, `${big} SENTINEL_${id}`))
    assert.ok(v2msgs.every((m) => m.id === undefined), "precondition: no message ids")

    const legacy1 = I.v2ToLegacy(v2msgs)
    const r1 = I.buildWindow(legacy1, "ses_noid_w1", 40000) // first observation (windowState=undefined)
    assert.ok(r1.stats.evictedCount > 0, "baseline must evict → marker present in the output")

    // Next context call: core re-assembles the SAME append-only history but without m.id fields. Fresh objects — derived ids must come out identical.
    const legacy2 = I.v2ToLegacy(JSON.parse(JSON.stringify(v2msgs)))
    assert.equal(legacy2[0].info.id, legacy1[0].info.id, "deriveMsgID must be content+position deterministic")

    const state = { firstId: r1.stats.firstId, units: r1.stats.units, evicted: r1.stats.evictedCount }
    const r2 = I.buildWindow(legacy2, "ses_noid_w1", 40000, undefined, undefined, undefined, undefined, undefined, undefined, state)
    assert.equal(r2.stats.firstId, r1.stats.firstId, "first unit fingerprint unchanged → no head change")
    assert.ok(r2.stats.evictedCount >= r1.stats.evictedCount, `false sticky reset: ${r2.stats.evictedCount} < ${r1.stats.evictedCount}`)
  })

  it("core adopts the spliced window and drops ids: exactly one legitimate reset, then stable (no flapping)", () => {
    const v2msgs: any[] = []
    for (const id of ["A", "B", "C"]) v2msgs.push(...mkV2Unit(id, `question ${id}`, `${big} SENTINEL_${id}`))
    const r1 = I.buildWindow(I.v2ToLegacy(v2msgs), "ses_noid_w2", 40000)
    assert.ok(r1.stats.evictedCount > 0)
    const state = { firstId: r1.stats.firstId, units: r1.stats.units, evicted: r1.stats.evictedCount }

    // Worst case: core persists our spliced window (evicted units gone from its view) and strips ids.
    const stripIds = (v2: any[]): any[] => v2.map(({ id, ...rest }: any) => rest)
    const legacy3 = I.v2ToLegacy(stripIds(I.legacyToV2(r1.messages)))
    assert.ok(legacy3.length > 0 && legacy3[0].info.id !== state.firstId, "head genuinely replaced (evicted units left core's view)")
    const r3 = I.buildWindow(legacy3, "ses_noid_w2", 40000, undefined, undefined, undefined, undefined, undefined, undefined, state)
    assert.ok(r3.stats.evictedCount < state.evicted, "one-shot sticky reset fired — legitimate here: the history WAS actually replaced")

    // No flapping: re-feeding the same id-less window next turn must be fingerprint-stable and stick.
    const state2 = { firstId: r3.stats.firstId, units: r3.stats.units, evicted: r3.stats.evictedCount }
    const legacy4 = I.v2ToLegacy(stripIds(I.legacyToV2(r3.messages)))
    assert.equal(legacy4[0].info.id, legacy3[0].info.id, "head fingerprint stable across round-trips")
    const r4 = I.buildWindow(legacy4, "ses_noid_w2", 40000, undefined, undefined, undefined, undefined, undefined, undefined, state2)
    assert.equal(r4.stats.firstId, r3.stats.firstId, "no head change on the stable window")
    assert.ok(r4.stats.evictedCount >= r3.stats.evictedCount, `flapping: repeated reset (${r4.stats.evictedCount} < ${r3.stats.evictedCount})`)
  })
})

// ---------- review round-2 items 1–5: fail-closed taint, visible failures, O(1) wiki budget, honest consolidate report ----------

describe("review round-2 items 1-5", () => {
  // item 1 (taint): the taint check itself threw → the session must be TAINTED anyway. Safe direction is a false positive
  // (blocks memory writes for this turn); a silent skip would leave prompt-injection defense off. Plus an error line under the default logLevel.
  it("item 1: a throwing taint check still marks the session tainted (fail-closed) and logs [taint] at error level", async () => {
    const wt = freshRoot()
    try {
      await I.ensureInit(wt)
      fs.writeFileSync(path.join(I.hippoRoot(wt), "hippocampus.json"), JSON.stringify({ untrustedTools: ["webfetch"] }))
      // Patch the shared Map instance (internals exposes the same object the plugin code calls): first .set throws, later ones pass through.
      const m = I.taintedBySession as any
      const origSet = m.set.bind(m)
      let calls = 0
      m.set = (k: string, v: boolean) => {
        if (++calls === 1) throw new Error("taint-logic-broken")
        return origSet(k, v)
      }
      try {
        const fx = await fakePluginCtx(wt)
        try {
          const hook = fx.toolHooks.get("execute.after")!
          await hook({ sessionID: "sT1", tool: "webfetch", status: "completed", id: "", input: {}, result: { content: "" } })
        } finally {
          fx.close()
        }
      } finally {
        delete m.set // restore the inherited Map.prototype.set
      }
      assert.equal(I.taintedBySession.get("sT1"), true, "fail-closed: session must be tainted even though the taint check itself threw")
      assert.equal(I.isTainted("sT1"), true)
      const log = readLogLine(wt)
      assert.match(log, /ERROR \[taint\]/, `log was:\n${log}`)
      assert.match(log, /taint-logic-broken/)
    } finally {
      rmrf(wt)
    }
  })

  // item 1 (capture): output extraction threw → the full output is lost for windowing stubs. Was a silent `catch {}`.
  it("item 1: a throwing capture logs [capture] at error level", async () => {
    const wt = freshRoot()
    try {
      await I.ensureInit(wt)
      const fx = await fakePluginCtx(wt)
      try {
        const hook = fx.toolHooks.get("execute.after")!
        // A result whose `output` getter throws makes toolResultToText throw inside the capture block (no monkeypatching needed).
        await hook({ sessionID: "sC1", tool: "shell", status: "completed", id: "c1", input: {}, result: { get output() { throw new Error("kapow-capture") } } })
      } finally {
        fx.close()
      }
      const log = readLogLine(wt)
      assert.match(log, /ERROR \[capture\]/, `log was:\n${log}`)
      assert.match(log, /kapow-capture/)
    } finally {
      rmrf(wt)
    }
  })

  // item 1 (tool-error): the error-logging path itself threw (unstringifiable event.error → JSON.stringify rejects). Was a silent `catch {}`.
  it("item 1: an unstringifiable tool error still logs [tool-error] at error level", async () => {
    const wt = freshRoot()
    try {
      await I.ensureInit(wt)
      const fx = await fakePluginCtx(wt)
      try {
        const hook = fx.toolHooks.get("execute.after")!
        const err: any = { a: 0 }
        err.a = err // circular → JSON.stringify(event.error) throws inside the logging path itself
        await hook({ sessionID: "sE1", tool: "shell", status: "error", id: "", input: {}, error: err })
      } finally {
        fx.close()
      }
      const log = readLogLine(wt)
      assert.match(log, /ERROR \[tool-error\]/, `log was:\n${log}`)
      assert.match(log, /[Cc]ircular/)
    } finally {
      rmrf(wt)
    }
  })

  // item 1 (recall): a lost recall entry is a hole in the conversation history. Was debugLog(e) — invisible at the default level and mis-attributed.
  it("item 1: a failed recall append logs [recall] at error level", async () => {
    const wt = freshRoot()
    try {
      await I.ensureInit(wt)
      // A FILE where the recall dir must be → mkdir(recursive) throws EEXIST deterministically.
      const recallPath = path.join(I.hippoRoot(wt), "recall")
      fs.rmSync(recallPath, { recursive: true, force: true })
      fs.writeFileSync(recallPath, "x")
      const fx = await fakePluginCtx(wt)
      try {
        const hook = fx.toolHooks.get("execute.after")!
        await hook({ sessionID: "sR1", tool: "shell", status: "completed", id: "", input: {}, result: { content: "hi" } })
      } finally {
        fx.close()
      }
      const log = readLogLine(wt)
      assert.match(log, /ERROR \[recall\]/, `log was:\n${log}`)
    } finally {
      rmrf(wt)
    }
  })

  // item 2 (core-memory): a failed HUMAN-block migration leaves core-memory.md in the old broken shape. Was debugLog(e).
  it("item 2: a failed migration logs [core-memory] at error level and leaves the file untouched", async () => {
    const wt = freshRoot()
    try {
      const root = I.hippoRoot(wt)
      // Pre-create everything ensureInit would mkdir, plus an OLD-SHAPE core-memory.md (bare "HUMAN" inside PERSONA),
      // so the only failing step is the migration's atomicWrite.
      for (const d of ["memfs/archive", "recall", "raw", "checkpoints", "wiki", "attachments", "logs"]) fs.mkdirSync(path.join(root, d), { recursive: true })
      fs.writeFileSync(path.join(root, "core-memory.md"), '## PERSONA\nI am old.\nHUMAN\n(nothing recorded yet)\n')
      await I.logEvent(wt, "error", "seed", new Error("seed")) // seed a writable log file BEFORE the dir goes read-only
      fs.chmodSync(root, 0o555) // atomicWrite's tmp cannot be created; appending to the existing (writable) log file still works
      try {
        await I.ensureInit(wt) // must not throw: the migration failure is caught and logged
      } finally {
        fs.chmodSync(root, 0o755)
      }
      const cm = fs.readFileSync(path.join(root, "core-memory.md"), "utf8")
      assert.ok(cm.includes("\nHUMAN\n"), "migration must not have half-applied: the file stays in the old shape")
      assert.ok(!/^##\s+HUMAN/m.test(cm), "no new HUMAN header may appear after a failed migration")
      const log = readLogLine(wt)
      assert.match(log, /ERROR \[core-memory\]/, `log was:\n${log}`)
      assert.match(log, /EACCES/)
    } finally {
      rmrf(wt)
    }
  })

  // item 2 (raw-write): the rollback itself failed → the file may hold a PARTIAL unit = duplicate lines on retry. Was debugLog(e2).
  it("item 2: a failed rollback logs [raw-write] at error level", async () => {
    const wt = freshRoot()
    try {
      await I.ensureInit(wt)
      const log = I.getSessionLog(wt, "sRB1") // unique session id: module state is keyed by it
      const mkU = (id: string, text: string): any => ({ info: { id, role: "user", time: { created: Date.now(), completed: Date.now() } }, parts: [{ id: `${id}_p`, type: "text", text }] })
      await log.writeUnits([mkU("u_rb1", "first")], {}) // normal write → the raw file exists with header + unit 1
      const f = I.sessionFilePath(wt, "sRB1")
      fs.unlinkSync(f)
      fs.symlinkSync("/nonexistent-hippo-target", f) // broken link: appendFile fails AND the rollback's stat fails too
      // broken symlink: appendFile fails EACCES, the rollback's stat fails ENOENT (logged as e2)
      await assert.rejects(log.writeUnits([mkU("u_rb2", "second")], {}), /EACCES/, "the original append failure must still propagate")
      const logText = readLogLine(wt)
      assert.match(logText, /ERROR \[raw-write\].*partial append rolled back/, `log was:\n${logText}`)
      assert.match(logText, /ERROR \[raw-write\].*Error: ENOENT/, "the failed rollback itself must be logged (was a silent debugLog)")
    } finally {
      rmrf(wt)
    }
  })

  // item 2 (attach): the full stack of a failed archive must land in THIS project's log at debug level.
  // Was debugLog(e) — without worktree it would follow currentWorktree (another project, or nowhere).
  it("item 2: a failed attachment archive logs its stack into this project's own log", async () => {
    const wt = freshRoot()
    try {
      await I.ensureInit(wt)
      I.applyLogLevel(wt, "debug") // existing config surface (logLevel key), set directly for determinism
      fs.chmodSync(path.join(I.hippoRoot(wt), "attachments"), 0o555) // saveAttachment's writeFile fails EACCES
      try {
        await I.archiveUserMedia([mkImageMsg("uM1", PNG_1PX)], wt, undefined) // must not throw: per-part failures are caught and logged
      } finally {
        fs.chmodSync(path.join(I.hippoRoot(wt), "attachments"), 0o755)
      }
      const logText = readLogLine(wt)
      assert.match(logText, /ERROR \[attach\].*exception archiving file part/, `log was:\n${logText}`)
      assert.match(logText, /DEBUG \[hippocampus\] Error: EACCES/, "the full stack must be attributed to THIS project at debug level")
    } finally {
      rmrf(wt)
    }
  })

  // item 3+4 (wiki budget): a NON-GROWING overwrite cannot increase count or total → allowed without any walk.
  // Old code walked the whole tree per page (O(N²) in consolidate's step-4 loop) and refused shrinking edits on an already-over-budget tree.
  it("items 3+4: shrinking overwrite under an over-budget tree is allowed; growing overwrite beyond the limit is refused", async () => {
    const wt = freshRoot()
    try {
      await I.ensureInit(wt)
      const root = I.hippoRoot(wt)
      fs.writeFileSync(path.join(root, "wiki", "a.md"), "x".repeat(200))
      fs.writeFileSync(path.join(root, "wiki", "b.md"), "y".repeat(200)) // tree = 400 bytes, budget = 100 → already over
      const res = await I.wikiWriteFile(root, "a.md", "x".repeat(50), { maxTotalBytes: 100 })
      assert.equal(res.error, undefined, `shrinking overwrite under an over-budget tree must not be refused; got ${res.error}`)
      assert.equal(fs.readFileSync(path.join(root, "wiki", "a.md"), "utf8").length, 50)
      // Growing overwrite: accounted as bytes - existingSize + newSize → 250 - 50 + 300 = 500 > 100.
      const res2 = await I.wikiWriteFile(root, "a.md", "x".repeat(300), { maxTotalBytes: 100 })
      assert.match(res2.error ?? "", /size limit/)
    } finally {
      rmrf(wt)
    }
  })

  // item 3 (page budget): the page limit applies to NEW pages only — a tree at its page budget stays writable for overwrites.
  it("item 3: at the page budget new pages are refused but existing-page overwrites stay allowed", async () => {
    const wt = freshRoot()
    try {
      await I.ensureInit(wt)
      const root = I.hippoRoot(wt)
      fs.writeFileSync(path.join(root, "wiki", "a.md"), "x".repeat(100))
      fs.writeFileSync(path.join(root, "wiki", "b.md"), "y".repeat(100)) // tree at the page budget (2/2)
      assert.match((await I.wikiWriteFile(root, "c.md", "z".repeat(10), { maxPages: 2 })).error ?? "", /page limit/)
      const res = await I.wikiWriteFile(root, "a.md", "x".repeat(50), { maxPages: 2 })
      assert.equal(res.error, undefined, `an overwrite never grows the count; got ${res.error}`)
    } finally {
      rmrf(wt)
    }
  })

  // item 5 (consolidate honesty): step-4's rewrite was refused → the report must say FAILED, not "removed dangling".
  // Trigger: a page above the 262144-byte per-page cap — its link-cleanup rewrite is refused ("page too large") on both old and new budget logic.
  it("item 5: consolidate reports links: FAILED when the step-4 rewrite is refused", async () => {
    const wt = freshRoot()
    try {
      await I.ensureInit(wt)
      const wikiDir = path.join(I.hippoRoot(wt), "wiki")
      fs.writeFileSync(path.join(wikiDir, "big.md"), `---\ntitle: Big\ntype: concept\n---\nsee [[ghost]] here\n${"x".repeat(280 * 1024)}\n`)
      fs.writeFileSync(path.join(wikiDir, "small.md"), "---\ntitle: Small\ntype: concept\n---\nbody two\n")
      const cfg = await I.loadConfig(wt) // defaults (500 pages / 8 MiB): the tree fits the budget, only the per-page cap bites
      const report = await I.consolidate(wt, cfg)
      assert.match(report, /links: FAILED big\.md/, `report was:\n${report}`)
      assert.match(report, /page too large/)
      assert.ok(!report.includes("removed dangling"), "a refused rewrite must not be reported as success")
      assert.ok(fs.readFileSync(path.join(wikiDir, "big.md"), "utf8").includes("[[ghost]]"), "the refused write must not touch the file on disk")
    } finally {
      rmrf(wt)
    }
  })
})

// ============================================================================
// Round-4 hard regression suite: security (isSafeWorktree), SENSITIVE_FILE_RE,
// compaction-stable message ids, cyclic tool input, marker budget boundary,
// pruneDir double-unlink, redaction tail, checkpoint prune ENOENT race,
// buildWindow written guard + perf, SOP regex, raw/ symlinks, in-flight media.
// ============================================================================

describe("isSafeWorktree (security)", () => {
  it("1.1 rejects homedir", () => {
    assert.equal(I.isSafeWorktree(os.homedir()), false)
  })

  it("1.2 rejects filesystem root", () => {
    // win32: path.parse(w).root is "C:\\" — same check, different constant
    assert.equal(I.isSafeWorktree("/"), false)
  })

  it("1.3 rejects symlink to homedir (regression fix2: path.resolve did not follow symlinks)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hippo-safe-"))
    try {
      fs.symlinkSync(os.homedir(), path.join(tmp, "evil"))
      assert.equal(I.isSafeWorktree(path.join(tmp, "evil")), false)
    } finally {
      rmrf(tmp)
    }
  })

  it("1.4 rejects symlink to filesystem root", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hippo-safe-"))
    try {
      fs.symlinkSync("/", path.join(tmp, "evil-root"))
      assert.equal(I.isSafeWorktree(path.join(tmp, "evil-root")), false)
    } finally {
      rmrf(tmp)
    }
  })

  it("1.5 accepts a legitimate project dir", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hippo-safe-"))
    try {
      assert.equal(I.isSafeWorktree(tmp), true)
    } finally {
      rmrf(tmp)
    }
  })

  it("1.6 resolves nested symlink chains (a -> b -> homedir)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hippo-safe-"))
    try {
      const b = path.join(tmp, "b")
      const a = path.join(tmp, "a")
      fs.symlinkSync(os.homedir(), b)
      fs.symlinkSync(b, a)
      assert.equal(I.isSafeWorktree(a), false)
    } finally {
      rmrf(tmp)
    }
  })

  it("1.7 handles missing paths gracefully (no throw; falls back to the literal resolved path)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hippo-safe-"))
    try {
      const missing = path.join(tmp, "no-such-dir", "deeper")
      let r: unknown
      assert.doesNotThrow(() => {
        r = I.isSafeWorktree(missing) // realpathSync throws internally and is swallowed by the source's catch {}
      })
      assert.equal(r, true, "a missing subpath of /tmp is neither homedir nor fs root")
    } finally {
      rmrf(tmp)
    }
  })
})

describe("SENSITIVE_FILE_RE", () => {
  // Fixed this round: bare .envrc (direnv files hold secrets) now matches; .env.* allows at most ONE suffix, so .bak chains stop matching.
  for (const name of [".env", ".env.local", ".env.production", ".envrc", "id_rsa", "id_ed25519", "cert.pem", "server.pem", "my-key.pem", "any.pem", "foo.key", "private.key", "credentials", "credentials.json"]) {
    it(`matches sensitive: ${name}`, () => {
      assert.equal(I.isSensitiveFile(name), true, `expected "${name}" to be flagged sensitive`)
    })
  }
  for (const name of ["readme.md", "config.ts", ".env.example.bak", "package.json", "tsconfig.json", "cert.txt", "server.pem.backup"]) {
    it(`does not match: ${name}`, () => {
      assert.equal(I.isSensitiveFile(name), false, `expected "${name}" to pass through`)
    })
  }
})

describe("deriveMsgID / v2ToLegacy compaction stability", () => {
  // V2 messages WITHOUT ids → the deriveMsgID fingerprint path (with an id, it is used as-is and the regression hides).
  const mkV2 = (role: string, text: string) => ({ role, content: [{ type: "text", text }] })

  it("3.1 stable across head truncation (regression fix3 v2: duplicates in raw after provider compaction)", () => {
    const A = mkV2("user", "alpha message one")
    const B = mkV2("assistant", "bravo reply two")
    const C = mkV2("user", "charlie question three")
    const D = mkV2("assistant", "delta answer four")
    const E = mkV2("user", "echo follow-up five")
    const full = I.v2ToLegacy([A, B, C, D, E])
    const sliced = I.v2ToLegacy([C, D, E]) // provider compacted the head: same objects, new positions
    assert.match(full[2].info.id, /^msgx_[0-9a-f]{16}$/)
    for (let k = 0; k < 3; k++) {
      assert.equal(full[k + 2].info.id, sliced[k].info.id, `message ${String.fromCharCode(67 + k)} id must be bit-for-bit identical after head truncation`)
    }
  })

  it("3.2 different content → different id", () => {
    const a = I.deriveMsgID(mkV2("user", "first variant"))
    const b = I.deriveMsgID(mkV2("user", "second variant"))
    assert.notEqual(a, b)
  })

  it("3.3 byte-identical same-role messages collapse to one id (documented trade-off of the pure content fingerprint)", (t) => {
    t.diagnostic("two byte-identical user messages share an id; dedup treats them as the same message — accepted on purpose, pinned here so a future change is deliberate")
    const a = I.deriveMsgID(mkV2("user", "hello"))
    const b = I.deriveMsgID(mkV2("user", "hello"))
    assert.equal(a, b)
  })

  it("3.4 deterministic: same input → same id across repeated v2ToLegacy calls (part ids churn per audit #17, message ids must not)", () => {
    const m = mkV2("assistant", "deterministic reply")
    assert.equal(I.deriveMsgID(m), I.deriveMsgID(m))
    const run1 = I.v2ToLegacy([m, mkV2("user", "next question")])
    const run2 = I.v2ToLegacy([m, mkV2("user", "next question")])
    for (let i = 0; i < run1.length; i++) assert.equal(run1[i].info.id, run2[i].info.id)
  })
})

describe("unitSize cyclic tool input", () => {
  it("4.1-4.4 cyclic state.input does not crash; inTok falls back to 4 (regression fix4: JSON.stringify TypeError killed the context hook)", () => {
    const cyclic: any = {}
    cyclic.self = cyclic
    const part: any = { id: "p1", type: "tool", tool: "bash", callID: "c1", state: { input: cyclic, output: "" } }
    const unit: any = { id: "u1", messages: [{ info: { id: "m1", role: "assistant" }, parts: [part] }] }
    const metrics = new WeakMap()
    let n: number
    assert.doesNotThrow(() => {
      n = I.unitSize(unit, false, false, I.DEFAULT_CONFIG, "pref", undefined, metrics)
    })
    assert.equal(typeof n, "number")
    assert.ok(Number.isFinite(n))
    assert.equal(n, 4, "inTok fallback (4) + empty output (0)")
    assert.equal(metrics.get(part).inputJsonTok, 4, "the fallback must be memoized into PartMetrics too")
  })
})

describe("markerBlock token budget", () => {
  const prefix = ".hippocampus/raw/ses_boundary.md"
  const mkUnits = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `u_${"a".repeat(20)}${i}`,
      messages: [{ info: { id: `m${i}`, role: "user" as const }, parts: [{ id: `t${i}`, type: "text", text: "word one two three four five six seven eight." }] }],
    }))

  it("5.1 fits within budget → full marker list + pull hint", () => {
    const out = I.markerBlock(mkUnits(2), prefix, { ...I.DEFAULT_CONFIG, markerBudgetTokens: 1_000_000 })
    assert.ok(out.includes("[offloaded →"), `got: ${out.slice(0, 80)}`)
    assert.match(out, /pull any segment back/)
  })

  it("5.2 exceeds budget (100 units vs markerBudgetTokens=1000) → TOC format", () => {
    const out = I.markerBlock(mkUnits(100), prefix, I.DEFAULT_CONFIG)
    assert.ok(out.startsWith("[100 segments offloaded:"), `got: ${out.slice(0, 80)}`)
  })

  it("5.3 boundary: budget+1 → TOC; exactly budget → full (regression fix6: the tail hint was not counted in the budget)", () => {
    const units = mkUnits(5)
    const outFull = I.markerBlock(units, prefix, { ...I.DEFAULT_CONFIG, markerBudgetTokens: 1_000_000 }) // guaranteed full+hint shape
    const cost = I.estTokens(outFull) // exactly the value markerBlock compares against cfg.markerBudgetTokens (estTokens(full + hint))
    assert.ok(cost > 1, "sanity")
    const over = I.markerBlock(units, prefix, { ...I.DEFAULT_CONFIG, markerBudgetTokens: cost - 1 })
    assert.ok(over.startsWith("[5 segments offloaded:"), `budget+1 must fall into TOC format; got: ${over.slice(0, 80)}`)
    const exact = I.markerBlock(units, prefix, { ...I.DEFAULT_CONFIG, markerBudgetTokens: cost })
    assert.match(exact, /pull any segment back/, "exactly at budget the full list must still fit (<= comparison)")
  })
})

describe("pruneDir retention + size pass", () => {
  it("6.1-6.5 deletes old then over-size files, keeps newest, exactly one log line per file (regression fix7: removed-set)", async (t) => {
    const wt = freshRoot()
    t.after(() => rmrf(wt))
    I.applyLogLevel(wt, "info") // prune lines are info-level; the default logLevel=error would swallow them
    const dir = path.join(I.hippoRoot(wt), "raw")
    fs.mkdirSync(dir, { recursive: true })
    const now = Date.now()
    for (let i = 1; i <= 5; i++) {
      const f = path.join(dir, `f${String(i).padStart(2, "0")}.md`) // old: 2 days → retention pass
      fs.writeFileSync(f, "x".repeat(100))
      fs.utimesSync(f, (now - 2 * 864e5) / 1000, (now - 2 * 864e5) / 1000)
    }
    for (let i = 6; i <= 10; i++) {
      const f = path.join(dir, `f${String(i).padStart(2, "0")}.md`) // new: seconds ago; f06=now-5s … f10=now-1s → f10 strictly newest
      fs.writeFileSync(f, "x".repeat(100))
      const tms = now - (11 - i) * 1000
      fs.utimesSync(f, tms / 1000, tms / 1000)
    }

    await I.pruneDir(wt, dir, ".md", 0, 1) // retentionDays=1 removes f01-f05; maxBytes=0 then removes everything except the newest

    assert.deepEqual(fs.readdirSync(dir), ["f10.md"], "only the newest file survives")

    const log = fs.readFileSync(path.join(I.hippoRoot(wt), "logs", `${new Date().toISOString().slice(0, 10)}.log`), "utf8")
    const deleted = [...log.matchAll(/deleted raw\/(f\d+\.md) \((?:age > 1d|size limit)\)/g)].map((m) => m[1])
    assert.equal(deleted.length, 9, `expected exactly 9 prune log lines (5 retention + 4 size), got:\n${log}`)
    const counts = new Map<string, number>()
    for (const n of deleted) counts.set(n, (counts.get(n) ?? 0) + 1) // a double unlink attempt would show up as a second line or a missing decrement
    assert.deepEqual([...counts.keys()].sort(), ["f01.md", "f02.md", "f03.md", "f04.md", "f05.md", "f06.md", "f07.md", "f08.md", "f09.md"])
    for (const [n, c] of counts) assert.equal(c, 1, `${n} was pruned ${c} times — double unlink/double counting`)
    assert.ok(!log.includes("f10.md"), "the newest file must never be logged as deleted")
  })
})

describe("redactSecrets (round-4)", () => {
  const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456ghi789"

  it("7.1 redacts a full three-segment JWT", () => {
    const out = I.redactSecrets(`token: ${JWT} end`)
    assert.ok(out.includes("[REDACTED]"), `got: ${out}`)
    assert.ok(!out.includes("eyJ"))
  })

  it("7.2 a space between segments must NOT match (regression fix8: unescaped dot in the JWT regex)", () => {
    const s = "eyJabc12345678901234567890 XYZ abc12345678901234567890"
    assert.equal(I.redactSecrets(s), s, 'the literal "." in the JWT regex must not act as a wildcard')
  })

  it("7.3 tail beyond redactMaxBytes is left untouched (documented: scanning is bounded to the first N chars)", (t) => {
    t.diagnostic(`expected behavior: only the first ${I.DEFAULT_CONFIG.redactMaxBytes} bytes are scanned; a secret at ~1.5 MB inside a 2 MB string survives redaction`)
    const s = "x".repeat(1_500_000) + JWT + "y".repeat(2_000_000 - 1_500_000 - JWT.length) // exactly 2 MB, secret at offset ~1.5 MB
    assert.equal(s.length, 2_000_000)
    const out = I.redactSecrets(s) // default redactMaxBytes = 1 MiB
    assert.equal(out, s, "the tail must be byte-identical; nothing before the cut contains secrets")
  })

  it("7.4 Bearer token (16+ chars) → 'Bearer [REDACTED]'", () => {
    const out = I.redactSecrets("Authorization: Bearer abcdefghij1234567890")
    assert.equal(out, "Authorization: Bearer [REDACTED]")
  })
})

describe("writeCheckpoint prune (ENOENT between readdir and stat)", () => {
  it("8.1 files vanishing before stat do not kill the prune; exactly the oldest live files are removed (regression fix10: Promise.all rejected → prune skipped entirely)", async (t) => {
    const wt = freshRoot()
    t.after(() => rmrf(wt))
    const dir = path.join(I.hippoRoot(wt), "checkpoints")
    fs.mkdirSync(dir, { recursive: true })
    const now = Date.now()
    for (let i = 1; i <= 24; i++) {
      const f = path.join(dir, `ses-old-${String(i).padStart(3, "0")}.md`) // mtime grows older with i → the five oldest are i=24..20
      fs.writeFileSync(f, "x")
      const tms = now - i * 60_000
      fs.utimesSync(f, tms / 1000, tms / 1000)
    }
    // Broken symlinks named *.md: readdir lists them, stat() follows the link and rejects ENOENT —
    // exactly the "deleted between readdir and stat" race, reproduced deterministically without mocking
    // (node:test cannot patch node:fs/promises ESM bindings — see the @skip block at the end).
    for (let j = 1; j <= 7; j++) fs.symlinkSync("/nonexistent/hippo-target", path.join(dir, `gone-${j}.md`))

    const messages: any[] = [{ info: { id: "m1", role: "user" }, parts: [{ id: "p1", type: "text", text: "hi" }] }]
    const file = await I.writeCheckpoint(wt, "ses_test", messages, "core", I.DEFAULT_CONFIG) // maxCheckpoints=20

    const entries = fs.readdirSync(dir).map((n) => ({ n, l: fs.lstatSync(path.join(dir, n)) }))
    const real = entries.filter((e) => e.l.isFile()).map((e) => e.n).sort()
    assert.equal(real.length, 20, `prune must keep the newest ${I.DEFAULT_CONFIG.maxCheckpoints} live files; got: ${real.join(",")}`)
    for (let i = 20; i <= 24; i++) {
      const name = `ses-old-${String(i).padStart(3, "0")}.md`
      assert.ok(!real.includes(name), `${name} is among the oldest live files and must be pruned`)
    }
    for (let j = 1; j <= 7; j++) {
      const name = `gone-${j}.md`
      assert.equal(fs.lstatSync(path.join(dir, name)).isSymbolicLink(), true, "broken links are not our files to delete")
    }
    assert.ok(fs.existsSync(file), "the fresh checkpoint itself survives the prune (it is the newest file)")
  })
})

describe("buildWindow written guard", () => {
  it("9.1-9.4 evictEnd never passes unwritten units; a 500-unit window stays fast (regression: O(n²) marker recomputation)", () => {
    const N = 500
    // Media-heavy units with empty text: ~96 tok/unit from the inline base64 image, and hintOf() is cheap on them.
    // Perf note (measured here): the eviction scan probes every evictEnd 0..E once, so markerBlock runs E(E+1)/2 ≈ 124k
    // times at N=500 — markerTokCache dedupes across PASSES, not within this monotonic scan. That is inherent O(E²/2)
    // algorithm cost (~140 ms here with cheap hints; ~400 ms with 200-char text hints), so the budget below guards against
    // order-of-magnitude regressions (e.g. dropping the cache entirely), not an absolute <100 ms target at N=500.
    const messages: any[] = Array.from({ length: N }, (_, i) => ({
      info: { id: `u${i}`, role: "user" },
      parts: [
        { id: `p${i}`, type: "text", text: "" },
        { id: `f${i}`, type: "file", url: `data:image/png;base64,${"A".repeat(1024)}`, filename: null }, // ceil(1024*3/4/8)=96 tok/unit; cap = 1000*capRatio(0.2) = 200 → natural evictEnd lands near N-1
      ],
    }))
    const written = new Set(messages.slice(0, 250).map((m) => m.info.id))

    const free = I.buildWindow(messages, "ses_w", 1000, I.DEFAULT_CONFIG) // no guard: sticky eviction wants to evict almost everything
    assert.ok(free.stats.evictedCount > 250, `control run must want to evict past the written frontier (got ${free.stats.evictedCount})`)

    const t0 = process.hrtime.bigint()
    const guarded = I.buildWindow(messages, "ses_w", 1000, I.DEFAULT_CONFIG, undefined, written)
    const dtMs = Number(process.hrtime.bigint() - t0) / 1e6

    assert.equal(guarded.stats.evictedCount, 250, "the written guard must clamp evictEnd exactly at the last written unit")
    // Budget = order-of-magnitude regression guard (measured ~140 ms on i9-13900HK; without markerTokCache it is >1 s).
    assert.ok(dtMs < 500, `500-unit buildWindow took ${dtMs.toFixed(1)} ms (budget 500 ms — see perf note above)`)
  })
})

describe("extractSopCandidates", () => {
  const SOP_LINES = [
    "noise line before the tools",
    '[tool read call args={"path":"a"}]',
    '[tool bash call args={"cmd":"ls -la"}]',
    '[tool write call args={"file":"b","content":"x"}]',
    "noise after",
  ].join("\n")

  it("10.1-10.3 finds the read→bash→write 3-gram across two sessions (an empty result means the [tool regex is broken)", async () => {
    const wt = freshRoot()
    try {
      const raw = path.join(I.hippoRoot(wt), "raw")
      fs.mkdirSync(raw, { recursive: true })
      // A candidate requires the 3-gram in >= 2 DIFFERENT sessions — one file alone is not a procedure.
      fs.writeFileSync(path.join(raw, "ses_a.md"), SOP_LINES)
      fs.writeFileSync(path.join(raw, "ses_b.md"), SOP_LINES)

      const cands = await I.extractSopCandidates(wt)
      assert.ok(cands.length > 0, `extractSopCandidates returned [] — the /^\\[tool (\\S+) call args=/ regex matches nothing`)
      const g = cands.find((c: any) => c.slug === "read-bash-write")
      assert.ok(g, `expected slug read-bash-write in: ${JSON.stringify(cands)}`)
      assert.deepEqual(g.tools, ["read", "bash", "write"])
      assert.deepEqual(g.sessions, ["ses_a", "ses_b"])
    } finally {
      rmrf(wt)
    }
  })

  it("10.4 a single session is not a candidate (documents the >=2-sessions rule)", async () => {
    const wt = freshRoot()
    try {
      const raw = path.join(I.hippoRoot(wt), "raw")
      fs.mkdirSync(raw, { recursive: true })
      fs.writeFileSync(path.join(raw, "ses_c.md"), SOP_LINES)
      assert.deepEqual(await I.extractSopCandidates(wt), [])
    } finally {
      rmrf(wt)
    }
  })
})

describe("resolveContextFile (symlinks inside raw/)", () => {
  it("11.1-11.4 latest ignores symlinks pointing outside the project; explicit resolution of such a symlink is refused", async (t) => {
    const wt = freshRoot()
    const outside = path.join(os.tmpdir(), `hippo-outside-${Date.now()}-${Math.random().toString(36).slice(2)}.md`)
    t.after(() => {
      rmrf(wt)
      try { fs.unlinkSync(outside) } catch {}
    })
    const raw = path.join(I.hippoRoot(wt), "raw")
    fs.mkdirSync(raw, { recursive: true })
    fs.writeFileSync(outside, "outside content")
    const real = path.join(raw, "real.md")
    fs.writeFileSync(real, "real content")
    fs.utimesSync(real, (Date.now() - 10_000) / 1000, (Date.now() - 10_000) / 1000)
    const evil = path.join(raw, "evil.md") // symlink to outside with a NEWER mtime — must still lose the race
    fs.symlinkSync(outside, evil)
    fs.lutimesSync(evil, (Date.now() + 60_000) / 1000, (Date.now() + 60_000) / 1000)

    const latest = await I.resolveContextFile(wt)
    assert.equal(latest, real, "the newest REGULAR file wins; the symlink is skipped by lstat")

    assert.equal(await I.resolveContextFile(wt, "evil.md"), null, "an explicit path through a symlink leaving raw/ must be refused (isInsideReal)")
  })
})

describe("substituteArchivedAttachments in-flight assistant", () => {
  it("12.1 an in-flight assistant with no content yet does not un-protect the user's base64 (edge case: assistant exists, has not answered)", async (t) => {
    const root = freshRoot()
    t.after(() => rmrf(root))
    const b64 = Buffer.from(`img-${Date.now()}-${Math.random().toString(36).slice(2)}`).toString("base64")
    await I.archiveUserMedia([{ info: { id: "u0", role: "user" }, parts: [{ id: "f0", type: "file", mime: "image/png", url: `data:image/png;base64,${b64}` }] }], root)

    // V2 wire shape: user turn with media + an assistant message that has produced no parsable content yet.
    const v2 = [
      { role: "user", content: [{ type: "text", text: "look" }, { type: "media", media: { source: { type: "base64", data: b64, mediaType: "image/png" }, mediaType: "image/png" } }] },
      { role: "assistant", content: [] },
    ]
    const legacy = I.v2ToLegacy(v2)
    assert.equal(legacy.length, 1, "an empty in-flight assistant is dropped by v2ToLegacy (parts.length===0 → continue)")
    assert.equal(legacy[0].info.role, "user")

    const sub = I.substituteArchivedAttachments(legacy, root)
    const filePart = sub[0].parts.find((p: any) => p.type === "file")
    assert.ok(filePart, "the user's base64 must survive — no assistant after it in legacy means answeredAfter=false")
    assert.ok(String(filePart!.url).startsWith("data:image/png;base64,"))
  })

  it("12.2 documented current semantics: an in-flight assistant WITH partial content counts as an answer", async (t) => {
    t.diagnostic("V2 carries no completion timestamp (audit round-3 #11): ANY assistant message sets answeredAfter=true, so a partially-streamed reply already triggers substitution. A real guard needs core to surface time.completed — see the @skip block at the end.")
    const root = freshRoot()
    t.after(() => rmrf(root))
    const b64 = Buffer.from(`img2-${Date.now()}-${Math.random().toString(36).slice(2)}`).toString("base64")
    const user: any = { info: { id: "u1", role: "user" }, parts: [{ id: "f1", type: "file", mime: "image/png", url: `data:image/png;base64,${b64}` }] }
    await I.archiveUserMedia([user], root)
    const asstPartial: any = { info: { id: "a1", role: "assistant" }, parts: [{ id: "p1", type: "text", text: "partial..." }] } // no time.completed

    const sub = I.substituteArchivedAttachments([user, asstPartial], root)
    assert.equal(sub[0].parts[0].type, "text", "current behavior: substituted to a ref")
    assert.match(String(sub[0].parts[0].text), /^\[attachment saved: \.hippocampus\/attachments\//)
  })
})

describe("not covered (@skip)", () => {
  it.skip("block 8 via mock.method(fs.stat, ENOENT): node:test cannot patch ESM bindings", () => {
    // Verified empirically on Node 22 and 24: mock.method(node:fs/promises namespace, "stat") throws
    // "Cannot redefine property: stat" — hippocampus.ts uses a NAMED import (import { stat } from "node:fs/promises"),
    // and ESM namespaces are frozen. The race is reproduced instead with broken symlinks named *.md
    // (a real ENOENT from stat on a readdir-listed entry) in test 8.1.
  })

  it.skip("in-flight assistant WITH partial content must not trigger substitution", () => {
    // Spec expectation: answeredAfter=false while the assistant is still streaming. Not implementable today: V2 has no
    // completion timestamp, so any "is it finished?" check would make substitution dead code for all of V2; a real guard
    // needs core to surface time.completed on finished turns (test 12.2 documents current semantics instead).
  })

  it.skip("pruneDir double-unlink observed via a mocked logPrune", () => {
    // logPrune is not exported through __hippoInternals; the regression is observable through the leveled log file instead —
    // test 6.x asserts exactly one prune line per deleted file, which a double unlink/double counting would break.
  })
})
