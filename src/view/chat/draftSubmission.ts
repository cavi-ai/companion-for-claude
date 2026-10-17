export interface DraftStart {
  current(): boolean;
  accepted(): void;
}

/** Keep input until durable acceptance, without clearing later edits or another chat. */
export class DraftSubmission {
  private starting = false;
  get pending(): boolean { return this.starting; }

  async run(input: HTMLTextAreaElement, current: () => boolean, resize: () => void, submit: (start: DraftStart) => Promise<boolean>): Promise<boolean> {
    if (this.starting) return false;
    this.starting = true;
    const original = input.value;
    let edited = false;
    let released = false;
    const onInput = () => { edited = true; };
    input.addEventListener("input", onInput);
    const release = (accepted: boolean) => {
      if (released) return;
      released = true;
      input.removeEventListener("input", onInput);
      this.starting = false;
      if (accepted && current() && !edited && input.value === original) {
        input.value = "";
        resize();
      }
    };
    try {
      return await submit({ current, accepted: () => release(true) });
    } finally {
      release(false);
    }
  }
}
