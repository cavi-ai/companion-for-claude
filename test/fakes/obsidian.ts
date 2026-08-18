// Minimal in-memory fake of the Obsidian API surface used by the plugin's
// testable modules (currently src/mcp/vaultTools.ts). Vitest aliases the
// "obsidian" import to this file so we can exercise VaultTools against a real
// vault without launching Obsidian.
//
// Only the pieces the code under test actually touches are implemented; if a
// new dependency on the Obsidian API appears, add it here.

import { buildFrontmatter, type FrontmatterData } from "../../src/indexing/frontmatter";
import { parse as parseYamlImpl, stringify as stringifyYamlImpl } from "yaml";
export const parseYaml = (value: string): unknown => parseYamlImpl(value);
export const stringifyYaml = (value: unknown): string => stringifyYamlImpl(value);

export function normalizePath(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

export const Platform = { isMobile: false, isDesktop: true, isLinux: false, isMacOS: true, isWin: false };

export const requestUrl = async (): Promise<never> => {
  throw new Error("requestUrl is not available in tests — inject a fake HTTP adapter instead.");
};

export class TFile {
  path: string;
  basename: string;
  extension: string;
  stat: { mtime: number; ctime: number; size: number };
  /** internal content store (not part of the real Obsidian API) */
  _content: string;

  constructor(path: string, content: string, mtime: number) {
    this.path = path;
    this._content = content;
    this.stat = { mtime, ctime: mtime, size: content.length };
    const name = path.split("/").pop() ?? path;
    const dot = name.lastIndexOf(".");
    this.extension = dot > 0 ? name.slice(dot + 1) : "";
    this.basename = dot > 0 ? name.slice(0, dot) : name;
  }
}

export class TFolder {
  constructor(public path: string) {}
}

type EventCallback = (...args: unknown[]) => void;

class FakeEventSource {
  private listeners = new Map<string, EventCallback[]>();

  on(name: string, callback: EventCallback): EventCallback {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback]);
    return callback;
  }

  trigger(name: string, ...args: unknown[]): void {
    for (const callback of this.listeners.get(name) ?? []) callback(...args);
  }
}

interface FileCache {
  tags?: Array<{ tag: string }>;
  frontmatter?: Record<string, unknown>;
}

/** Mirrors Obsidian's getAllTags(cache): returns "#tag" strings or null. */
export function getAllTags(cache: FileCache | null): string[] | null {
  if (!cache) return null;
  const out: string[] = [];
  for (const t of cache.tags ?? []) out.push(t.tag);
  const fm = cache.frontmatter?.tags;
  if (Array.isArray(fm)) for (const t of fm) out.push(String(t).startsWith("#") ? String(t) : `#${t}`);
  return out;
}

class FakeVault extends FakeEventSource {
  private files = new Map<string, TFile>();
  private folders = new Set<string>();
  /** path -> tag strings (without #), used to build the metadata cache */
  tags = new Map<string, string[]>();
  /** path -> frontmatter object */
  frontmatters = new Map<string, Record<string, unknown>>();

  /** Test helper: seed a note. */
  seed(path: string, content: string, opts: { mtime?: number; tags?: string[]; frontmatter?: Record<string, unknown> } = {}): TFile {
    const p = normalizePath(path);
    const file = new TFile(p, content, opts.mtime ?? Date.now());
    this.files.set(p, file);
    if (opts.tags?.length) this.tags.set(p, opts.tags);
    if (opts.frontmatter) this.frontmatters.set(p, opts.frontmatter);
    const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
    if (dir) this.folders.add(dir);
    return file;
  }

  getMarkdownFiles(): TFile[] {
    return [...this.files.values()].filter((f) => f.extension === "md");
  }

  getFiles(): TFile[] {
    return [...this.files.values()];
  }

  getAbstractFileByPath(path: string): TFile | TFolder | null {
    const p = normalizePath(path);
    const f = this.files.get(p);
    if (f) return f;
    if (this.folders.has(p)) return new TFolder(p);
    return null;
  }

  cachedRead(file: TFile): Promise<string> {
    return Promise.resolve(file._content);
  }

  createFolder(path: string): Promise<void> {
    const parts = normalizePath(path).split("/");
    for (let index = 1; index <= parts.length; index += 1) this.folders.add(parts.slice(0, index).join("/"));
    return Promise.resolve();
  }

  create(path: string, content: string): Promise<TFile> {
    const p = normalizePath(path);
    if (this.files.has(p)) throw new Error(`File already exists: ${p}`);
    const file = new TFile(p, content, Date.now());
    this.files.set(p, file);
    return Promise.resolve(file);
  }

  append(file: TFile, content: string): Promise<void> {
    file._content += content;
    file.stat.size = file._content.length;
    return Promise.resolve();
  }

  modify(file: TFile, content: string): Promise<void> {
    file._content = content;
    file.stat.size = content.length;
    return Promise.resolve();
  }

  process(file: TFile, fn: (content: string) => string): Promise<string> {
    const next = fn(file._content);
    file._content = next;
    file.stat.size = next.length;
    return Promise.resolve(next);
  }

  /** Test helper used by FakeFileManager.renameFile. */
  _moveFile(file: TFile, newPath: string): void {
    this.files.delete(file.path);
    file.path = newPath;
    const name = newPath.split("/").pop() ?? newPath;
    const dot = name.lastIndexOf(".");
    file.basename = dot > 0 ? name.slice(0, dot) : name;
    this.files.set(newPath, file);
    const dir = newPath.includes("/") ? newPath.slice(0, newPath.lastIndexOf("/")) : "";
    if (dir) this.folders.add(dir);
  }
}

class FakeMetadataCache extends FakeEventSource {
  resolvedLinks: Record<string, Record<string, number>> = {};
  constructor(private vault: FakeVault) { super(); }
  getFileCache(file: TFile): FileCache | null {
    const tags = this.vault.tags.get(file.path);
    const frontmatter = this.vault.frontmatters.get(file.path);
    if (!tags && !frontmatter) return null;
    const cache: FileCache = {};
    if (tags) cache.tags = tags.map((t) => ({ tag: t.startsWith("#") ? t : `#${t}` }));
    if (frontmatter) cache.frontmatter = frontmatter;
    return cache;
  }
}

/**
 * Minimal fake of Obsidian's FileManager. Only `processFrontMatter` is needed.
 * Parses the leading `---...---` block of the file into a plain object (simple
 * `key: value` scalars + `tags:` list shape — enough to exercise OUR callback
 * logic, not Obsidian's full YAML engine), runs the callback to mutate it, then
 * re-serializes via the production `buildFrontmatter` and rejoins with the body.
 */
class FakeFileManager {
  constructor(private vault: FakeVault) {}

  renameFile(file: TFile, newPath: string): Promise<void> {
    const p = normalizePath(newPath);
    this.vault._moveFile(file, p);
    return Promise.resolve();
  }

  async processFrontMatter(file: TFile, fn: (frontmatter: Record<string, unknown>) => void): Promise<void> {
    const m = /^---\n([\s\S]*?)\n---\n?/.exec(file._content);
    const obj: Record<string, unknown> = {};
    let body = file._content;
    if (m) {
      const fmLines = m[1].split("\n");
      for (let i = 0; i < fmLines.length; i++) {
        const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(fmLines[i]);
        if (!kv) continue;
        const key = kv[1];
        const rest = kv[2].trim();
        if (rest === "" || rest === "[]") {
          const items: string[] = [];
          while (i + 1 < fmLines.length && /^\s*-\s+/.test(fmLines[i + 1])) {
            items.push(fmLines[++i].replace(/^\s*-\s+/, "").trim().replace(/^"(.*)"$/, "$1"));
          }
          obj[key] = items;
        } else {
          obj[key] = rest.replace(/^"(.*)"$/, "$1");
        }
      }
      body = file._content.slice(m[0].length).replace(/^\n+/, "");
    }
    fn(obj);
    file._content = `${buildFrontmatter(obj as FrontmatterData)}\n\n${body}`;
    file.stat.size = file._content.length;
    return Promise.resolve();
  }
}

export class FakeSecretStorage {
  private data = new Map<string, string>();
  setSecret(id: string, secret: string): void {
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`Invalid secret id: ${id}`);
    this.data.set(id, secret);
  }
  getSecret(id: string): string | null { return this.data.get(id) ?? null; }
  listSecrets(): string[] { return [...this.data.keys()]; }
}

export class App {
  vault = new FakeVault();
  metadataCache = new FakeMetadataCache(this.vault);
  fileManager = new FakeFileManager(this.vault);
  workspace = {
    getLeaf: () => ({ openFile: async () => undefined }),
    getLeavesOfType: (_type: string): unknown[] => [],
  };
  secretStorage = new FakeSecretStorage();
}

/** Version the fake reports; tests flip it to exercise the pre-1.11.5 path. */
let fakeApiVersion = "1.11.5";
export function setApiVersion(version: string): void { fakeApiVersion = version; }
export function requireApiVersion(version: string): boolean {
  const parse = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [a, b, c] = parse(fakeApiVersion);
  const [x, y, z] = parse(version);
  return a !== x ? a > x : b !== y ? b > y : c >= z;
}

// Value stubs for modules that import these names (not exercised in tests).
const noticeHistory: Notice[] = [];
export function clearNotices(): void { noticeHistory.length = 0; }
export function getNoticeMessages(): string[] { return noticeHistory.map((notice) => notice.message); }
export function getNotices(): readonly Notice[] { return noticeHistory; }
export class Notice {
  hidden = false;
  constructor(public message: string, public timeout?: number) { noticeHistory.push(this); }
  hide(): void { this.hidden = true; }
  setMessage(message: string): void { this.message = message; }
}
export class FileSystemAdapter {
  constructor(private readonly basePath = "") {}
  getBasePath(): string { return this.basePath; }
}
export function setIcon(parent: FakeElement, icon: string): void { parent.setAttr("data-icon", icon); }
export class FakeElement {
  tagName: string;
  children: FakeElement[] = [];
  attributes = new Map<string, string>();
  classList = new Set<string>();
  textContent = "";
  disabled = false;
  value = "";
  type = "";
  rows = 0;
  style: Record<string, string> = {};
  parent: FakeElement | null = null;
  setCssStyles(styles: Record<string, string>): void { Object.assign(this.style, styles); }
  setCssProperty(name: string, value: string): void { this.style[name] = value; }
  setCssProps(props: Record<string, string>): void { Object.assign(this.style, props); }
  private listeners = new Map<string, Array<(event: any) => void>>();
  constructor(tag = "div") { this.tagName = tag.toUpperCase(); }
  empty(): void { for (const child of this.children) child.parent = null; this.children = []; this.textContent = ""; }
  addClass(name: string): void { this.classList.add(name); }
  removeClass(name: string): void { this.classList.delete(name); }
  toggleClass(name: string, force?: boolean): void {
    const on = force ?? !this.classList.has(name);
    if (on) this.classList.add(name); else this.classList.delete(name);
  }
  appendText(text: string): void { this.textContent += text; }
  appendChild<T>(child: T): T { const element = child as unknown as FakeElement; element.parent = this; this.children.push(element); return child; }
  createEl(tag: string, options: any = {}): FakeElement {
    const child = new FakeElement(tag);
    child.textContent = options.text ?? "";
    for (const name of String(options.cls ?? "").split(/\s+/).filter(Boolean)) child.classList.add(name);
    for (const [key, value] of Object.entries(options.attr ?? {})) child.attributes.set(key, String(value));
    child.parent = this;
    this.children.push(child);
    return child;
  }
  createDiv(options: any = {}): FakeElement { return this.createEl("div", options); }
  createSpan(options: any = {}): FakeElement { return this.createEl("span", options); }
  addEventListener(type: string, listener: (event: any) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  dispatchEvent(event: any): boolean { for (const listener of this.listeners.get(event.type) ?? []) listener(event); return true; }
  focus(): void { this.attributes.set("data-focused", "true"); }
  setAttr(name: string, value: string): void { this.attributes.set(name, String(value)); }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
  setText(text: string): void { this.textContent = text; }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  querySelectorAll(selector: string): FakeElement[] { return this.walk().filter((item) => matches(item, selector)); }
  querySelector(selector: string): FakeElement | null { return this.querySelectorAll(selector)[0] ?? null; }
  private walk(): FakeElement[] { return this.children.flatMap((child) => [child, ...child.walk()]); }
}
function matches(item: FakeElement, selector: string): boolean {
  if (selector.startsWith("#")) return item.getAttribute("id") === selector.slice(1);
  const role = /^\[role="([^"]+)"\]$/.exec(selector); if (role) return item.getAttribute("role") === role[1];
  if (selector.startsWith(".")) return item.classList.has(selector.slice(1));
  return item.tagName === selector.toUpperCase();
}
/** Obsidian exposes createFragment() as a global; settings descriptions use it. */
(globalThis as unknown as { createFragment?: unknown }).createFragment ??= (
  callback?: (frag: FakeElement) => void,
): FakeElement => {
  const frag = new FakeElement("fragment");
  callback?.(frag);
  return frag;
};

export class Plugin {}
export class MarkdownView {}
export class WorkspaceLeaf {
  constructor(public app: App = new App()) {}
}
export class ItemView {
  app: App;
  contentEl = new FakeElement() as unknown as HTMLElement;
  constructor(public leaf: WorkspaceLeaf) { this.app = leaf.app; }
  registerEvent(_event: unknown): void {}
  getViewType(): string { return ""; }
  getDisplayText(): string { return ""; }
  getIcon(): string { return ""; }
  onOpen(): Promise<void> { return Promise.resolve(); }
}
let lastOpenedModal: Modal | undefined;
export function getLastOpenedModal(): Modal | undefined { return lastOpenedModal; }
export class Modal {
  containerEl = new FakeElement() as unknown as HTMLElement;
  modalEl = new FakeElement() as unknown as HTMLElement;
  titleEl = new FakeElement("h2");
  contentEl = new FakeElement() as unknown as HTMLElement;
  closed = false;
  constructor(public app: App) {}
  open(): void { lastOpenedModal = this; this.onOpen(); }
  close(): void { this.closed = true; this.onClose(); }
  onOpen(): void {}
  onClose(): void {}
}
export abstract class FuzzySuggestModal<T> extends Modal {
  abstract getItems(): T[];
  abstract getItemText(item: T): string;
  abstract onChooseItem(item: T): void;
}

// Settings-tab fakes: enough of the Setting/component surface for render
// smoke tests (labels + interactive controls present, callbacks wired).
abstract class BaseComponent {
  inputEl = new FakeElement("input");
  disabled = false;
  setDisabled(disabled: boolean): this { this.disabled = disabled; this.inputEl.disabled = disabled; return this; }
  setTooltip(tooltip: string): this { this.inputEl.attributes.set("title", tooltip); return this; }
}
export class TextComponent extends BaseComponent {
  private changeCb: ((value: string) => void) | null = null;
  getValue(): string { return this.inputEl.value; }
  setValue(value: string): this { this.inputEl.value = value; return this; }
  setPlaceholder(placeholder: string): this { this.inputEl.attributes.set("placeholder", placeholder); return this; }
  onChange(cb: (value: string) => void): this { this.changeCb = cb; return this; }
  simulateInput(value: string): void { this.inputEl.value = value; this.changeCb?.(value); }
}
export class TextAreaComponent extends TextComponent {
  override inputEl = new FakeElement("textarea");
}
export class DropdownComponent extends BaseComponent {
  options = new Map<string, string>();
  private changeCb: ((value: string) => void) | null = null;
  addOption(value: string, display: string): this { this.options.set(value, display); return this; }
  addOptions(options: Record<string, string>): this { for (const [v, d] of Object.entries(options)) this.options.set(v, d); return this; }
  getValue(): string { return this.inputEl.value; }
  setValue(value: string): this { this.inputEl.value = value; return this; }
  onChange(cb: (value: string) => void): this { this.changeCb = cb; return this; }
  simulateSelect(value: string): void { this.inputEl.value = value; this.changeCb?.(value); }
}
export class ToggleComponent extends BaseComponent {
  private changeCb: ((value: boolean) => void) | null = null;
  getValue(): boolean { return this.inputEl.value === "on"; }
  setValue(value: boolean): this { this.inputEl.value = value ? "on" : "off"; return this; }
  onChange(cb: (value: boolean) => void): this { this.changeCb = cb; return this; }
  simulateClick(): void { this.setValue(!this.getValue()); this.changeCb?.(this.getValue()); }
}
export class SliderComponent extends BaseComponent {
  private changeCb: ((value: number) => void) | null = null;
  setLimits(min: number, max: number, step: number): this { this.inputEl.attributes.set("min", String(min)); this.inputEl.attributes.set("max", String(max)); this.inputEl.attributes.set("step", String(step)); return this; }
  setDynamicTooltip(): this { return this; }
  getValue(): number { return Number(this.inputEl.value); }
  setValue(value: number): this { this.inputEl.value = String(value); return this; }
  onChange(cb: (value: number) => void): this { this.changeCb = cb; return this; }
}
export class ButtonComponent extends BaseComponent {
  buttonEl = new FakeElement("button");
  private clickCb: (() => void) | null = null;
  setButtonText(text: string): this { this.buttonEl.setText(text); return this; }
  setCta(): this { this.buttonEl.addClass("mod-cta"); return this; }
  setWarning(): this { this.buttonEl.addClass("mod-warning"); return this; }
  setIcon(icon: string): this { this.buttonEl.attributes.set("data-icon", icon); return this; }
  onClick(cb: () => void): this { this.clickCb = cb; return this; }
  simulateClick(): void { this.clickCb?.(); }
}
export class ExtraButtonComponent extends ButtonComponent {}
export class SearchComponent extends TextComponent {}

type ComponentCtor = new () => BaseComponent;

export class Setting {
  settingEl: FakeElement;
  infoEl: FakeElement;
  controlEl: FakeElement;
  descEl: FakeElement;
  nameEl: FakeElement;
  components: BaseComponent[] = [];
  constructor(public containerEl: FakeElement) {
    this.settingEl = containerEl.createDiv({ cls: "setting-item" });
    this.infoEl = this.settingEl.createDiv({ cls: "setting-item-info" });
    this.nameEl = this.infoEl.createDiv({ cls: "setting-item-name" });
    this.descEl = this.infoEl.createDiv({ cls: "setting-item-description" });
    this.controlEl = this.settingEl.createDiv({ cls: "setting-item-control" });
  }
  setName(name: string): this { this.nameEl.setText(name); return this; }
  setDesc(desc: string | DocumentFragment): this { this.descEl.setText(typeof desc === "string" ? desc : ""); return this; }
  setHeading(): this { this.settingEl.addClass("setting-item-heading"); return this; }
  setClass(cls: string): this { this.settingEl.addClass(cls); return this; }
  setTooltip(tooltip: string): this { this.settingEl.attributes.set("title", tooltip); return this; }
  private add<T extends BaseComponent>(Ctor: ComponentCtor, cb: (component: never) => void): this {
    const component = new Ctor() as T;
    // Buttons carry buttonEl, not inputEl — append whichever the component owns
    // so an addButton row is reachable from the rendered tree.
    const el = (component as unknown as { buttonEl?: FakeElement }).buttonEl ?? component.inputEl;
    this.controlEl.appendChild(el);
    this.components.push(component);
    cb(component as never);
    return this;
  }
  addText(cb: (component: TextComponent) => void): this { return this.add<TextComponent>(TextComponent as unknown as ComponentCtor, cb as never); }
  addTextArea(cb: (component: TextAreaComponent) => void): this { return this.add<TextAreaComponent>(TextAreaComponent as unknown as ComponentCtor, cb as never); }
  addDropdown(cb: (component: DropdownComponent) => void): this { return this.add<DropdownComponent>(DropdownComponent as unknown as ComponentCtor, cb as never); }
  addToggle(cb: (component: ToggleComponent) => void): this { return this.add<ToggleComponent>(ToggleComponent as unknown as ComponentCtor, cb as never); }
  addSlider(cb: (component: SliderComponent) => void): this { return this.add<SliderComponent>(SliderComponent as unknown as ComponentCtor, cb as never); }
  addButton(cb: (component: ButtonComponent) => void): this { return this.add<ButtonComponent>(ButtonComponent as unknown as ComponentCtor, cb as never); }
  addExtraButton(cb: (component: ExtraButtonComponent) => void): this { return this.add<ExtraButtonComponent>(ExtraButtonComponent as unknown as ComponentCtor, cb as never); }
  addSearch(cb: (component: SearchComponent) => void): this { return this.add<SearchComponent>(SearchComponent as unknown as ComponentCtor, cb as never); }
}
export interface SettingControl {
  type: "toggle" | "dropdown" | "text" | "textarea" | "number" | "file" | "folder" | "slider" | "color";
  key: string;
  options?: Record<string, string>;
  placeholder?: string;
  rows?: number;
  min?: number;
  max?: number;
  step?: number | "any";
  defaultValue?: unknown;
  validate?: (value: never) => string | void | Promise<string | void>;
  disabled?: boolean | (() => boolean);
}
export interface SettingDefinitionItem {
  type?: "group" | "list" | "page";
  name?: string;
  heading?: string;
  desc?: string | DocumentFragment;
  aliases?: string[];
  searchable?: boolean | (() => boolean);
  visible?: boolean | (() => boolean);
  control?: SettingControl;
  action?: (el: HTMLElement, index: number) => void;
  render?: (setting: Setting, group: unknown) => void | (() => void);
  items?: SettingDefinitionItem[];
}
export type SettingGroupItem = SettingDefinitionItem;
export class PluginSettingTab {
  containerEl = new FakeElement() as unknown as HTMLElement;
  constructor(
    public app: App,
    public plugin: Plugin,
  ) {}
  display(): void {}
  hide(): void {}
  getSettingDefinitions(): SettingDefinitionItem[] { return []; }
  /** Obsidian re-derives the definitions and repaints; the fake just re-walks. */
  update(): void { renderDefinitions(this as unknown as PluginSettingTab, this.getSettingDefinitions()); }
  getControlValue(key: string): unknown { return (this.plugin as unknown as { settings: Record<string, unknown> }).settings[key]; }
  setControlValue(key: string, value: unknown): void | Promise<void> {
    (this.plugin as unknown as { settings: Record<string, unknown> }).settings[key] = value;
  }
  refreshDomState(): void {}
}

function truthy(value: boolean | (() => boolean) | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return typeof value === "function" ? value() : value;
}

/**
 * Render one definition the way the 1.13 host does: a `control` becomes a real
 * component bound to get/setControlValue, a `render` row hands the callback a
 * live Setting, and everything else is a name/desc row.
 */
function renderDefinition(tab: PluginSettingTab, def: SettingDefinitionItem): void {
  if (!truthy(def.visible, true)) return;
  const container = tab.containerEl as unknown as FakeElement;
  if (def.type === "group" || def.type === "page") {
    if (def.heading) new Setting(container).setName(def.heading).setHeading();
    for (const child of def.items ?? []) renderDefinition(tab, child);
    return;
  }
  const setting = new Setting(container);
  if (def.name) setting.setName(def.name);
  if (typeof def.desc === "string") setting.setDesc(def.desc);
  if (def.render) {
    def.render(setting, undefined);
    return;
  }
  const control = def.control;
  if (!control) return;
  const commit = (value: unknown): void => void tab.setControlValue(control.key, value);
  const current = tab.getControlValue(control.key);
  switch (control.type) {
    case "toggle":
      setting.addToggle((c) => c.setValue(Boolean(current)).onChange(commit));
      return;
    case "dropdown":
      setting.addDropdown((c) => {
        for (const [value, label] of Object.entries(control.options ?? {})) c.addOption(value, label);
        c.setValue(String(current ?? "")).onChange(commit);
      });
      return;
    case "slider":
      setting.addSlider((c) => c.setValue(Number(current ?? 0)).onChange(commit));
      return;
    case "textarea":
      setting.addTextArea((c) => c.setValue(String(current ?? "")).onChange(commit));
      return;
    default:
      setting.addText((c) => c.setValue(String(current ?? "")).onChange(commit));
      return;
  }
}

function renderDefinitions(tab: PluginSettingTab, defs: SettingDefinitionItem[]): void {
  (tab.containerEl as unknown as FakeElement).empty();
  for (const def of defs) renderDefinition(tab, def);
}

/**
 * Exercise a settings tab through the Obsidian 1.13 host contract. A subclass
 * that opts into declarative definitions is host-rendered from those
 * definitions; imperative tabs are opened through display().
 */
export function openSettingTab(tab: PluginSettingTab): void {
  const prototype = Object.getPrototypeOf(tab) as object;
  if (Object.prototype.hasOwnProperty.call(prototype, "getSettingDefinitions")) {
    renderDefinitions(tab, tab.getSettingDefinitions());
    return;
  }
  tab.display();
}
