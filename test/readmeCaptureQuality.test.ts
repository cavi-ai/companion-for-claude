import { describe, expect, test } from "vitest";
import { readFile, stat } from "node:fs/promises";
import { documentationAsset } from "./releaseLayout";

interface CaptureContract {
  path: string;
  width: number;
  height: number;
  maxHeightToWidth: number;
}

const captures: CaptureContract[] = [
  {
    path: documentationAsset("social-card.png", true),
    width: 1280,
    height: 640,
    maxHeightToWidth: 0.5,
  },
  {
    path: documentationAsset("hero.png"),
    width: 1600,
    height: 960,
    maxHeightToWidth: 0.65,
  },
  {
    path: documentationAsset("chat-panel.png"),
    width: 1040,
    height: 1040,
    maxHeightToWidth: 1.55,
  },
  {
    path: documentationAsset("artifact-inline.png"),
    width: 1600,
    height: 1200,
    maxHeightToWidth: 1,
  },
  {
    path: documentationAsset("local-fallback-indicator.png", true),
    width: 840,
    height: 672,
    maxHeightToWidth: 1.25,
  },
  {
    path: documentationAsset("agent-tool-chips.png", true),
    width: 1040,
    height: 920,
    maxHeightToWidth: 1.25,
  },
  {
    path: documentationAsset("diff-review.png", true),
    width: 1120,
    height: 760,
    maxHeightToWidth: 1,
  },
  {
    path: documentationAsset("research-desk.png", true),
    width: 1600,
    height: 1000,
    maxHeightToWidth: 1.15,
  },
  {
    path: documentationAsset("canvas-output.png", true),
    width: 1600,
    height: 1000,
    maxHeightToWidth: 0.65,
  },
  {
    path: documentationAsset("mcp-bridge-settings.png", true),
    width: 1360,
    height: 1496,
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
