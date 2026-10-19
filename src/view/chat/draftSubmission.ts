export interface DraftStart {
  current(): boolean;
  accepted(): void;
}

/** Keep input until durable acceptance, without clearing later edits or another chat. */
export class DraftSubmission {
  private starting: { current(): boolean; release(accepted: boolean): void } | null = null;
  get pending(): boolean {
    if (this.starting && !this.starting.current()) this.starting.release(false);
    return this.starting !== null;
  }

  async run(input: HTMLTextAreaElement, current: () => boolean, resize: () => void, submit: (start: DraftStart) => Promise<boolean>, consumeDraft = true): Promise<boolean> {
    if (this.pending) return false;
    const original = input.value;
    let edited = false;
    let released = false;
    const onInput = () => { edited = true; };
    input.addEventListener("input", onInput);
    const release = (accepted: boolean) => {
      if (released) return;
      released = true;
      input.removeEventListener("input", onInput);
      if (this.starting === pending) this.starting = null;
      if (consumeDraft && accepted && current() && !edited && input.value === original) {
        input.value = "";
        resize();
      }
    };
    const pending = { current, release };
    this.starting = pending;
    try {
      return await submit({ current, accepted: () => release(true) });
    } finally {
      release(false);
    }
  }
}
