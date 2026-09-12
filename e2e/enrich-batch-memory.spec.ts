import { test, expect } from "./fixtures";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchObsidianHarness, type ObsidianHarness } from "./obsidianHarness";

const ENABLED = process.env.CC_E2E_MEMORY === "1";
const CLIPS = 40;
const FILLER = Number(process.env.CC_E2E_MEMORY_NOTES ?? "2000");
const PHASE = process.env.CC_E2E_MEMORY_PHASE ? `-${process.env.CC_E2E_MEMORY_PHASE}` : "";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".tmp", "phase3");

const clipBody = (i: number, kb: number): string =>
  `---\ntitle: "Clip ${i}"\nsource: "https://example.test/clip-${i}"\nclipped: "2026-09-08"\n---\n` +
  `# Clip ${i}\n\n` + "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(Math.ceil((kb * 1024) / 57));

const fillerBody = (i: number): string => `# Filler ${i}\n\n` + `Note ${i} talks about cats, code, and the ocean. `.repeat(20);

function reply(i: number): string {
  return JSON.stringify({ title: `Clip ${i} typed`, site: "example.test", summary: `Summary of clip ${i}.` });
}

/**
 * Two-launch fixture: launch 1 seeds only the filler notes, primes the semantic
 * index over them, then closes (kept on disk). The 40 clips are written directly
 * to disk afterward — unindexed, like clips synced while the phone app is closed —
 * then launch 2 reuses the vault/profile. Obsidian's startup scan sees the new
 * clip files, but the plugin's reindex listeners register only after layout-ready,
 * so the clips stay unindexed until the batch itself modifies them.
 */
async function launchPrimed(): Promise<ObsidianHarness> {
  const fillerFiles: Record<string, string> = {};
  for (let i = 0; i < FILLER; i++) fillerFiles[`Notes/filler-${i}.md`] = fillerBody(i);
  let n = 0;
  const base = {
    embedStub: true,
    settingsOverride: { sourceCaptureEnabled: true, sourceEnrichOnCreate: false, sourceCaptureConsent: "allow", enrichmentDiagnostics: true, semanticEnabled: true },
    providerReply: (body: string) => (/summary/i.test(body) ? reply(n++) : null),
    providerDelayMs: 2000,
  };
  const seed = await launchObsidianHarness({ ...base, extraFiles: fillerFiles });
  await primeSemanticIndex(seed);
  const { vault, profile } = seed.paths;
  await seed.close({ keep: true });
  for (let i = 0; i < CLIPS; i++) {
    const dest = join(vault, "Clippings", `clip-${i}.md`);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, clipBody(i, 5 + ((i * 37) % 196)));
  }
  return launchObsidianHarness({ ...base, reuse: { vault, profile } });
}

/** Kick off a full semantic rebuild and wait until no "semantic" activity record is still running,
 *  so the index holds the filler notes before either enrichment run and every save serializes a
 *  realistic size instead of an empty index. */
async function primeSemanticIndex(harness: ObsidianHarness): Promise<void> {
  await harness.page.evaluate(async () => {
    await (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app.commands.executeCommandById("claude-companion:rebuild-semantic-index");
  });
  await expect.poll(async () => harness.page.evaluate(() => {
    const plugin = (window as unknown as { app: { plugins: { plugins: Record<string, { activity: { snapshot(): { records: Array<{ id: string; state: string }> } } }> } } }).app.plugins.plugins["claude-companion"];
    return plugin.activity.snapshot().records.some((r) => r.id.includes("semantic") && r.state === "running");
  }), { timeout: 15 * 60_000, intervals: [1000] }).toBe(false);
}

async function semanticIndexBytes(harness: ObsidianHarness): Promise<number> {
  const path = join(harness.paths.vault, ".obsidian", "plugins", "claude-companion", "semantic-index.json");
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function sampleHeap(harness: ObsidianHarness, until: () => Promise<boolean>, file: string): Promise<{ peak: number; samples: number }> {
  const cdp = await harness.page.context().newCDPSession(harness.page);
  await cdp.send("Performance.enable");
  const rows: string[] = ["t_ms,js_heap_used,js_heap_total"];
  const t0 = Date.now();
  let peak = 0;
  while (!(await until())) {
    const { metrics } = await cdp.send("Performance.getMetrics");
    const used = metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? 0;
    const total = metrics.find((m) => m.name === "JSHeapTotalSize")?.value ?? 0;
    peak = Math.max(peak, used);
    rows.push(`${Date.now() - t0},${used},${total}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, file), rows.join("\n") + "\n");
  return { peak, samples: rows.length - 1 };
}

async function batchDone(harness: ObsidianHarness): Promise<boolean> {
  return harness.page.evaluate(() => {
    const plugin = (window as unknown as { app: { plugins: { plugins: Record<string, { activity: { snapshot(): { records: Array<{ id: string; state: string }> } } }> } } }).app.plugins.plugins["claude-companion"];
    const rec = plugin.activity.snapshot().records.find((r) => r.id === "source-enrichment:inbox-batch");
    return rec !== undefined && rec.state !== "running";
  });
}

/** True once a `save-done` line appears after the most recent `batch-end` line,
 *  i.e. the post-batch reindex flush (embed all clips, stringify, write) has finished. */
async function flushSettled(harness: ObsidianHarness): Promise<boolean> {
  let log: string;
  try {
    log = await readFile(join(harness.paths.vault, "Claude", "enrichment-diagnostics.log"), "utf8");
  } catch {
    return false;
  }
  const lines = log.split("\n").filter(Boolean);
  const batchEndLine = [...lines].reverse().find((l) => l.split(" ")[2] === "batch-end");
  const batchEndTs = batchEndLine?.split(" ")[0];
  if (batchEndTs === undefined) return false;
  return lines.some((l) => l.split(" ")[2] === "save-done" && (l.split(" ")[0] ?? "") > batchEndTs);
}

async function enrichedCount(harness: ObsidianHarness): Promise<number> {
  let count = 0;
  for (let i = 0; i < CLIPS; i++) {
    const text = await readFile(join(harness.paths.vault, "Clippings", `clip-${i}.md`), "utf8");
    if (/^source_enriched:\s*true\s*$/m.test(text)) count++;
  }
  return count;
}

test.describe("batch enrichment memory", () => {
  test.skip(!ENABLED, "set CC_E2E_MEMORY=1");
  test.setTimeout(20 * 60_000);

  test("Enrich all over 40 clips", async () => {
    const harness = await launchPrimed();
    try {
      const indexBytes = await semanticIndexBytes(harness);
      await harness.page.evaluate(async () => {
        await (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app.commands.executeCommandById("claude-companion:open-source-inbox");
      });
      await harness.page.getByRole("button", { name: "Enrich all" }).click();
      const flushDeadline = Date.now() + 3 * 60_000;
      const { peak, samples } = await sampleHeap(
        harness,
        async () => {
          if (!(await batchDone(harness))) return false;
          if (await flushSettled(harness)) return true;
          if (Date.now() > flushDeadline) {
            const log = await readFile(join(harness.paths.vault, "Claude", "enrichment-diagnostics.log"), "utf8").catch(() => "<log unreadable>");
            const tail = log.split("\n").filter(Boolean).slice(-20).join("\n");
            throw new Error(`post-batch reindex flush did not complete within 3 minutes; log tail:\n${tail}`);
          }
          return false;
        },
        "memory-batch.csv",
      );
      const log = await readFile(join(harness.paths.vault, "Claude", "enrichment-diagnostics.log"), "utf8");
      await writeFile(join(OUT, "memory-batch.log"), log);
      expect(await enrichedCount(harness)).toBe(CLIPS);
      const flushes = (log.match(/reindex-flush-start/g) ?? []).length;
      const saves = [...log.matchAll(/save-start bytes=(\d+)/g)].map((m) => Number(m[1]));
      await writeFile(join(OUT, "memory-summary.md"), `| run | peak JS heap MB | samples | flushes | saves | max save bytes | semantic index bytes at start |\n|---|---|---|---|---|---|---|\n| batch${PHASE} | ${(peak / 1048576).toFixed(1)} | ${samples} | ${flushes} | ${saves.length} | ${Math.max(0, ...saves)} | ${indexBytes} |\n`, { flag: "w" });
    } finally {
      await harness.close();
    }
  });

  test("40 single enrichments 3 s apart", async () => {
    const harness = await launchPrimed();
    try {
      const indexBytes = await semanticIndexBytes(harness);
      await harness.page.evaluate(async () => {
        await (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app.commands.executeCommandById("claude-companion:open-source-inbox");
      });
      let done = 0;
      const driver = (async () => {
        for (let i = 0; i < CLIPS; i++) {
          const row = harness.page.locator(".cc-inbox-row", { hasText: `clip-${i}` });
          await row.getByRole("button", { name: `Enrich clip-${i}`, exact: true }).click();
          const file = join(harness.paths.vault, "Clippings", `clip-${i}.md`);
          await expect.poll(async () => /^source_enriched:\s*true\s*$/m.test(await readFile(file, "utf8")), { timeout: 60_000 }).toBe(true);
          await new Promise((r) => setTimeout(r, 3000));
          done++;
        }
      })();
      const { peak, samples } = await sampleHeap(harness, async () => done >= CLIPS, "memory-single.csv");
      await driver;
      const log = await readFile(join(harness.paths.vault, "Claude", "enrichment-diagnostics.log"), "utf8");
      await writeFile(join(OUT, "memory-single.log"), log);
      expect(await enrichedCount(harness)).toBe(CLIPS);
      const flushes = (log.match(/reindex-flush-start/g) ?? []).length;
      const saves = [...log.matchAll(/save-start bytes=(\d+)/g)].map((m) => Number(m[1]));
      await writeFile(join(OUT, "memory-summary.md"), `| single${PHASE} | ${(peak / 1048576).toFixed(1)} | ${samples} | ${flushes} | ${saves.length} | ${Math.max(0, ...saves)} | ${indexBytes} |\n`, { flag: "a" });
    } finally {
      await harness.close();
    }
  });
});
