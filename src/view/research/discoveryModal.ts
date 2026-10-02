import { Modal, type App } from "obsidian";
import type { DiscoveryCoordinator } from "../../discovery/coordinator";
import type { ProjectSnapshot } from "../../research/graph";
import { DiscoveryPanel } from "../DiscoveryPanel";

export class DiscoveryModal extends Modal {
  private panel: DiscoveryPanel | undefined;

  constructor(
    app: App,
    private readonly coordinator: DiscoveryCoordinator,
    private snapshot: ProjectSnapshot,
    private readonly reload: () => Promise<ProjectSnapshot>,
    private readonly openPath: (path: string) => Promise<void>,
    private readonly release: () => void,
  ) { super(app); }

  override onOpen(): void {
    this.titleEl.setText("Search papers");
    this.contentEl.addClass("cc-discovery-modal");
    this.panel = new DiscoveryPanel({ coordinator: this.coordinator, openPath: this.openPath, rerender: () => this.draw(true) });
    void this.draw(false);
  }

  private async draw(reload: boolean): Promise<void> {
    if (!this.panel) return;
    if (reload) this.snapshot = await this.reload();
    if (!this.panel) return;
    this.contentEl.empty();
    this.panel.render(this.contentEl, this.snapshot);
  }

  override onClose(): void {
    this.panel?.dispose();
    this.panel = undefined;
    this.contentEl.empty();
    this.release();
  }
}
