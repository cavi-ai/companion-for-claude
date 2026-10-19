import type { EventRef, Vault } from "obsidian";
import type { Composer } from "./Composer";

type Host = Pick<Composer, "attachedPaths" | "attachedMedia" | "renderContextManager">;

/** Follow native file/folder moves only for the live draft, with lifecycle-owned cleanup. */
export function watchAttachmentRenames(vault: Pick<Vault, "on">, host: Host, register: (ref: EventRef) => void): void {
  register(vault.on("rename", (file, oldPath) => {
    let changed = false;
    for (const item of [...host.attachedPaths, ...host.attachedMedia]) {
      if (!item.path || (item.path !== oldPath && !item.path.startsWith(`${oldPath}/`))) continue;
      item.path = file.path + item.path.slice(oldPath.length);
      if ("label" in item) item.label = item.path.split("/").pop() ?? item.path;
      changed = true;
    }
    if (changed) host.renderContextManager();
  }));
}
