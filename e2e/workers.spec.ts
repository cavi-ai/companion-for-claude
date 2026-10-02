import { expect, test } from "./fixtures";

const PLUGIN_DIR = ".obsidian/plugins/claude-companion";

function textPdf(word: string): Buffer {
  const stream = `BT /F1 24 Tf 72 700 Td (${word}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

type PluginHandle = {
  indexer(): { build(opts: { force: boolean }): Promise<unknown> } | null;
  builtinEmbedder(): { createWorker(): Worker };
};
type AppHandle = {
  plugins: { plugins: Record<string, PluginHandle> };
  vault: { createBinary(path: string, data: ArrayBuffer): Promise<unknown>; adapter: { read(path: string): Promise<string> } };
};

test("the bundled pdf.js worker extracts text from a vault PDF through the semantic index", async ({ rig }) => {
  const { page } = await rig.reset({ embedStub: true });
  const base64 = textPdf("zebracorn").toString("base64");
  await page.evaluate(async (data) => {
    const app = (window as unknown as { app: AppHandle }).app;
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    await app.vault.createBinary("zebracorn.pdf", bytes.buffer);
    await app.plugins.plugins["claude-companion"]!.indexer()!.build({ force: true });
  }, base64);
  const index = JSON.parse(await page.evaluate((dir) => (window as unknown as { app: AppHandle }).app.vault.adapter.read(`${dir}/semantic-index.json`), PLUGIN_DIR)) as { notes: Record<string, { chunks: { text: string }[] }> };
  expect(index.notes["zebracorn.pdf"]?.chunks.map((chunk) => chunk.text).join(" ")).toContain("zebracorn");
});

test("the bundled embedding worker boots and answers without a model download", async ({ rig }) => {
  const { page } = await rig.reset({ embedStub: true });
  const outcome = await page.evaluate(async () => {
    const plugin = (window as unknown as { app: AppHandle }).app.plugins.plugins["claude-companion"]!;
    const worker = plugin.builtinEmbedder().createWorker();
    const errors: string[] = [];
    worker.addEventListener("error", (event) => errors.push(event.message));
    const reply = await new Promise<{ id: number; type: string; message?: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no reply from the embedding worker within 10s")), 10_000);
      worker.addEventListener("message", (event) => { clearTimeout(timer); resolve(event.data as { id: number; type: string; message?: string }); });
      worker.postMessage({ id: 7, type: "embed", texts: ["x"] });
    });
    worker.terminate();
    return { errors, reply };
  });
  expect(outcome.errors).toEqual([]);
  expect(outcome.reply).toEqual({ id: 7, type: "error", message: "model not loaded" });
});
