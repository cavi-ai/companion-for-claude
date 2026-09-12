import { describe, expect, test } from "vitest";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const plugin = join(dirname(fileURLToPath(import.meta.url)), "..");

interface CaptureContract {
  path: string;
  width: number;
  height: number;
  maxHeightToWidth: number;
}

const captures: CaptureContract[] = [
  {
    path: join(plugin, "..", "assets", "social-card.png"),
    width: 1280,
    height: 640,
    maxHeightToWidth: 0.5,
  },
  {
    path: join(plugin, "assets", "chat-panel.png"),
    width: 1040,
    height: 662,
    maxHeightToWidth: 1.55,
  },
  {
    path: join(plugin, "assets", "artifact-inline.png"),
    width: 1600,
    height: 1403,
    maxHeightToWidth: 1,
  },
  {
    path: join(plugin, "..", "assets", "local-fallback-indicator.png"),
    width: 840,
    height: 752,
    maxHeightToWidth: 1.25,
  },
  {
    path: join(plugin, "..", "assets", "agent-tool-chips.png"),
    width: 1040,
    height: 952,
    maxHeightToWidth: 1.25,
  },
  {
    path: join(plugin, "..", "assets", "diff-review.png"),
    width: 1120,
    height: 716,
    maxHeightToWidth: 1,
  },
  {
    path: join(plugin, "..", "assets", "research-desk.png"),
    width: 1520,
    height: 1520,
    maxHeightToWidth: 1.15,
  },
  {
    path: join(plugin, "..", "assets", "research-workbench-intelligence.png"),
    width: 1520,
    height: 1520,
    maxHeightToWidth: 1.15,
  },
  {
    path: join(plugin, "..", "assets", "mcp-bridge-settings.png"),
    width: 1350,
    height: 1340,
    maxHeightToWidth: 1.1,
  },
];

describe("README capture quality", () => {
  test.each(captures)("keeps $path legible and tightly framed", async ({ path, width: expectedWidth, height: expectedHeight, maxHeightToWidth }) => {
    const png = await readFile(path);
    expect(png.subarray(1, 4).toString("ascii"), `${path} must be a PNG`).toBe("PNG");

    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    const bytes = (await stat(path)).size;

    expect(width, `${path} width must be deterministic`).toBe(expectedWidth);
    expect(height, `${path} height must be deterministic`).toBe(expectedHeight);
    expect(width, `${path} must not rely on browser downscaling`).toBeLessThanOrEqual(1600);
    expect(height, `${path} must not rely on browser downscaling`).toBeLessThanOrEqual(1600);
    expect(height / width, `${path} must not include a tall empty canvas`).toBeLessThanOrEqual(maxHeightToWidth);
    expect(bytes, `${path} must stay below GitHub's practical inline-image budget`).toBeLessThan(1_000_000);
  });
});
