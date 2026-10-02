import { FuzzySuggestModal, type App } from "obsidian";
import type { StandingOrder } from "../orders/order";

/** Fuzzy picker over valid standing orders for "Run standing order now…". */
export class OrderPicker extends FuzzySuggestModal<StandingOrder> {
  constructor(
    app: App,
    private orders: StandingOrder[],
    private onChoose: (order: StandingOrder) => void,
  ) {
    super(app);
    this.setPlaceholder("Choose a standing order to run…");
  }

  override getItems(): StandingOrder[] {
    return this.orders;
  }

  override getItemText(item: StandingOrder): string {
    return item.name;
  }

  override onChooseItem(item: StandingOrder): void {
    this.onChoose(item);
  }
}
