import { describe, it, expect } from "vitest";
import {
  encodeProjectDir,
  listSessionsForVault,
  type SessionReader,
  type SessionFile,
} from "../src/memory/sessions";

describe("encodeProjectDir", () => {
  it("maps every non-alphanumeric char to a dash (empirically confirmed)", () => {
    expect(encodeProjectDir("/Volumes/MIRZA/.hermes")).toBe("-Volumes-MIRZA--hermes");
    expect(encodeProjectDir("/Volumes/MIRZA/workspace/CAVI/plugins/claude-obsidian"))
      .toBe("-Volumes-MIRZA-workspace-CAVI-plugins-claude-obsidian");
  });
});

const line = (o: object) => JSON.stringify(o);
function fakeReader(files: Record<string, string>, metas: SessionFile[]): SessionReader {
  return {
    listFiles: async () => metas,
    read: async (path) => files[path] ?? "",
  };
}

describe("listSessionsForVault", () => {
  const vault = "/v/vault";
  const root = "/home/.claude/projects";
  const files = {
    "/p/a.jsonl": [line({ type: "user", cwd: vault, sessionId: "a", timestamp: "2026-06-01T00:00:00Z", message: { role: "user", content: "first task" } })].join("\n"),
    "/p/b.jsonl": [line({ type: "user", cwd: "/other", sessionId: "b", message: { role: "user", content: "elsewhere" } })].join("\n"),
  };
  const metas: SessionFile[] = [
    { id: "a", path: "/p/a.jsonl", mtimeMs: 100 },
    { id: "b", path: "/p/b.jsonl", mtimeMs: 200 },
  ];

  it("keeps only sessions whose cwd matches the vault, newest first, with a preview", async () => {
    const out = await listSessionsForVault(fakeReader(files, metas), vault, root);
    expect(out.map((s) => s.id)).toEqual(["a"]);
    expect(out[0].preview).toBe("first task");
    expect(out[0].cwd).toBe(vault);
  });

  it("returns [] when the project dir is absent", async () => {
    const reader: SessionReader = { listFiles: async () => [], read: async () => "" };
    expect(await listSessionsForVault(reader, vault, root)).toEqual([]);
  });
});
