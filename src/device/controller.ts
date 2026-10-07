import { Notice, Platform, type Plugin } from "obsidian";
import { probeDeviceGpu, type GpuReport } from "./gpu";

/** Explicit support check; registration performs no allocation or vault IO. */
export function registerDeviceGpuCheck(plugin: Plugin, probe: () => Promise<GpuReport> = probeDeviceGpu): void {
  let running: Promise<void> | undefined;
  const run = (): Promise<void> => {
    if (running) return running;
    running = (async () => {
      const report = await probe();
      const path = `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}/on-device-gpu.json`;
      await plugin.app.vault.adapter.write(path, JSON.stringify({ ...report, runtime: Platform.isIosApp ? "ios" : Platform.isAndroidApp ? "android" : "desktop", checkedAt: new Date().toISOString(), pluginVersion: plugin.manifest.version }, null, 2));
      new Notice(report.compute ? "On-device GPU compute works inside Obsidian." : `On-device GPU unavailable: ${report.reason ?? "unknown reason"}`);
    })().catch((error: unknown) => { new Notice(error instanceof Error ? error.message : String(error)); }).finally(() => { running = undefined; });
    return running;
  };
  plugin.addCommand({ id: "check-device-gpu", name: "Check on-device GPU support", callback: () => { void run(); } });
  plugin.registerObsidianProtocolHandler("claude-companion-device-check", () => { void run(); });
}
