// Pure keyboard model of the inline instruction prompt. No obsidian or CodeMirror imports.

export type PromptMode = "rewrite" | "insert";
export type PromptPhase = "editing" | "running";
export type PromptKey = "Enter" | "Escape" | "ArrowUp" | "ArrowDown" | "Tab" | "Shift-Tab";

export interface PromptState {
  mode: PromptMode;
  phase: PromptPhase;
  input: string;
  /** -1 is the input; 0..n-1 is a preset chip. */
  focus: number;
  /** Index into history while recalling, else null. */
  recall: number | null;
}

export type PromptEffect = { kind: "none" } | { kind: "submit"; instruction: string } | { kind: "close" } | { kind: "abort" };

export interface KeyResult {
  state: PromptState;
  effect: PromptEffect;
}

export const HISTORY_CAP = 20;
export const RUNNING_LABEL = "Working… Esc to stop";

const NONE: PromptEffect = { kind: "none" };

export function initialPrompt(mode: PromptMode): PromptState {
  return { mode, phase: "editing", input: "", focus: -1, recall: null };
}

export function placeholderFor(mode: PromptMode): string {
  return mode === "insert" ? "Write at cursor…" : "Rewrite selection…";
}

/** IME composition keys (isComposing, or keyCode 229) belong to the input method, never the prompt. */
export function promptKey(event: { key: string; shiftKey?: boolean; isComposing?: boolean; keyCode?: number }): PromptKey | null {
  if (event.isComposing || event.keyCode === 229) return null;
  if (event.key === "Tab") return event.shiftKey ? "Shift-Tab" : "Tab";
  if (event.key === "Enter" || event.key === "Escape" || event.key === "ArrowUp" || event.key === "ArrowDown") return event.key;
  return null;
}

/** Most recent first, no duplicates, at most HISTORY_CAP entries. */
export function remember(history: readonly string[], instruction: string): string[] {
  const text = instruction.trim();
  if (!text) return [...history];
  return [text, ...history.filter((h) => h !== text)].slice(0, HISTORY_CAP);
}

export function typed(state: PromptState, value: string): PromptState {
  if (state.phase !== "editing") return state;
  return { ...state, input: value, recall: null, focus: -1 };
}

export function choosePreset(state: PromptState, index: number, presets: readonly string[]): PromptState {
  const instruction = presets[index];
  if (state.phase !== "editing" || instruction === undefined) return state;
  return { ...state, input: instruction, focus: -1, recall: null };
}

export function pressKey(state: PromptState, key: PromptKey, ctx: { history: readonly string[]; presets: readonly string[] }): KeyResult {
  if (state.phase === "running") return { state, effect: key === "Escape" ? { kind: "abort" } : NONE };
  if (key === "Escape") return { state, effect: { kind: "close" } };
  const chips = ctx.presets.length;
  if (key === "Tab") return { state: { ...state, focus: chips === 0 ? -1 : state.focus + 1 >= chips ? -1 : state.focus + 1 }, effect: NONE };
  if (key === "Shift-Tab") return { state: { ...state, focus: chips === 0 ? -1 : state.focus <= -1 ? chips - 1 : state.focus - 1 }, effect: NONE };
  if (state.focus >= 0) {
    if (key === "Enter") return { state: choosePreset(state, state.focus, ctx.presets), effect: NONE };
    return { state, effect: NONE };
  }
  if (key === "Enter") {
    const instruction = state.input.trim();
    if (!instruction) return { state, effect: NONE };
    return { state: { ...state, phase: "running", recall: null }, effect: { kind: "submit", instruction } };
  }
  const recalling = state.recall !== null && state.input === ctx.history[state.recall];
  if (key === "ArrowUp") {
    if (ctx.history.length === 0 || (state.input !== "" && !recalling)) return { state, effect: NONE };
    const next = recalling ? Math.min(state.recall! + 1, ctx.history.length - 1) : 0;
    return { state: { ...state, input: ctx.history[next]!, recall: next }, effect: NONE };
  }
  if (!recalling) return { state, effect: NONE };
  const next = state.recall! - 1;
  return { state: next < 0 ? { ...state, input: "", recall: null } : { ...state, input: ctx.history[next]!, recall: next }, effect: NONE };
}
