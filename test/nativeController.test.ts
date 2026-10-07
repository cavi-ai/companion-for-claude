import { afterEach, describe, expect, it, vi } from "vitest";
import { App, Platform, type Plugin, type TFile } from "obsidian";
import { NativeHandoffController, registerNativeResultImport } from "../src/native/controller";
import { NATIVE_MODEL } from "../src/native/handoff";

const id = "11111111-2222-4333-8444-555555555555";
const folder = ".obsidian/plugins/claude-companion/native-jobs";
const path = `Claude/MLX/MLX ${id}.md`;
const platform = Platform as typeof Platform & { isIosApp?: boolean };
afterEach(() => { delete platform.isIosApp; });

function fixture() {
  const app = new App();
  const now = Date.now() / 1000;
  const jobs = new Map([
    [`${folder}/${id}.request.json`, JSON.stringify({ version: 1, id, createdAt: now, expiresAt: now + 3600,
      vaultName: "Research", sourcePath: "Source.md", input: "Original paragraph.", instruction: "Summarize." })],
    [`${folder}/${id}.result.json`, JSON.stringify({ version: 1, id, model: NATIVE_MODEL.repo, revision: NATIVE_MODEL.revision,
      output: "A summary.", instruction: "Summarize the key claim." })],
  ]);
  Object.assign(app.vault, {
    configDir: ".obsidian", getName: () => "Research",
    getFileByPath: (value: string) => app.vault.getAbstractFileByPath(value),
    adapter: {
      stat: vi.fn(async (value: string) => jobs.has(value) ? { type: "file", size: new TextEncoder().encode(jobs.get(value)).length } : null),
      read: vi.fn(async (value: string) => jobs.get(value)),
      remove: vi.fn(async (value: string) => { jobs.delete(value); }),
    },
  });
  const source = app.vault.seed("Source.md", "Original paragraph.");
  const plugin = { app, addCommand: vi.fn(), registerObsidianProtocolHandler: vi.fn() } as unknown as Plugin;
  return { app, jobs, source, plugin, controller: new NativeHandoffController(plugin) };
}

describe("native iPhone handoff ownership", () => {
  it("registers only on iOS and performs no vault IO during registration", () => {
    const { plugin, app } = fixture();
    platform.isIosApp = false;
    registerNativeResultImport(plugin);
    expect(plugin.addCommand).not.toHaveBeenCalled();
    expect(plugin.registerObsidianProtocolHandler).not.toHaveBeenCalled();
    platform.isIosApp = true;
    registerNativeResultImport(plugin);
    expect(plugin.addCommand).not.toHaveBeenCalled();
    expect(plugin.registerObsidianProtocolHandler).toHaveBeenCalledOnce();
    expect(app.vault.adapter.read).not.toHaveBeenCalled();
  });

  it("coalesces duplicate callbacks, imports the actual instruction, and preserves the source", async () => {
    const { controller, app, source, jobs } = fixture();
    const first = controller.receive(id);
    expect(controller.receive(id)).toBe(first);
    await first;
    const file = app.vault.getAbstractFileByPath(path);
    expect(file).not.toBeNull();
    expect(await app.vault.read(file as typeof source)).toContain("Summarize the key claim.");
    expect(await app.vault.read(source)).toBe("Original paragraph.");
    expect(jobs.size).toBe(0);
  });

  it("recovers an import interrupted before cleanup without replacing user edits", async () => {
    const { controller, app, jobs } = fixture();
    const savedJobs = new Map(jobs);
    await controller.receive(id);
    for (const entry of savedJobs) jobs.set(...entry);
    await controller.receive(id);
    const file = app.vault.getAbstractFileByPath(path) as TFile;
    await app.vault.modify(file, "User changed this result.");
    for (const entry of savedJobs) jobs.set(...entry);
    await expect(controller.receive(id)).rejects.toThrow("will not be overwritten");
    expect(await app.vault.read(file)).toBe("User changed this result.");
    expect(jobs.size).toBe(2);
  });

  it("rejects a wrong-vault result and oversized job before creating any note", async () => {
    const { controller, app } = fixture();
    Object.assign(app.vault, { getName: () => "Other vault" });
    await expect(controller.receive(id)).rejects.toThrow("another vault");
    Object.assign(app.vault, { getName: () => "Research" });
    vi.mocked(app.vault.adapter.stat).mockResolvedValue({ type: "file", size: 32_769, ctime: 0, mtime: 0 });
    await expect(controller.receive(id)).rejects.toThrow("supported size");
    expect(app.vault.getAbstractFileByPath(path)).toBeNull();
  });
});
