import { describe, expect, it, vi } from "vitest";
import { reserveHostStatusBar, statusBarBottomInset } from "../../src/view/chat/hostInsets";

const rect = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });

describe("chat host status bar space", () => {
  it("reserves the observed native status bar overlap above Send", () => {
    expect(statusBarBottomInset(rect(1080, 40, 1600, 1000), rect(1305.53125, 973, 1600, 1000))).toBe(27);
  });

  it("leaves nonintersecting panes and already bounded host layouts unchanged", () => {
    const bar = rect(1305.53125, 973, 1600, 1000);
    expect(statusBarBottomInset(rect(340, 40, 1080, 1000), bar)).toBe(0);
    expect(statusBarBottomInset(rect(1080, 40, 1600, 973), bar)).toBe(0);
    expect(statusBarBottomInset(rect(1080, 40, 1600, 1000), rect(0, 0, 0, 0))).toBe(0);
  });

  it("updates for bar size, visibility, replacement and pane relocation, then releases its lifecycle", () => {
    let paneBounds = rect(1080, 40, 1600, 1000);
    let barBounds = rect(1305.53125, 973, 1600, 1000);
    let visibility = "visible";
    let display = "flex";
    let pending: Parameters<typeof globalThis.requestAnimationFrame>[0] | null = null;
    let layoutChanged = (): void => {};
    const unsubscribe = vi.fn();
    const properties = new Map<string, string>();
    const resizeCallbacks: ConstructorParameters<typeof globalThis.ResizeObserver>[0][] = [];
    const mutationCallbacks: ConstructorParameters<typeof globalThis.MutationObserver>[0][] = [];
    const observed = vi.fn();
    const unobserved = vi.fn();
    const resizeDisconnected = vi.fn();
    const mutationDisconnected = vi.fn();
    const removedListener = vi.fn();
    const cancelFrame = vi.fn(() => { pending = null; });
    const bar = { getBoundingClientRect: () => barBounds };
    let currentBar: typeof bar | null = bar;
    const view = {
      requestAnimationFrame: vi.fn((callback: Parameters<typeof globalThis.requestAnimationFrame>[0]) => { pending = callback; return 1; }),
      cancelAnimationFrame: cancelFrame,
      getComputedStyle: () => ({ visibility, display }),
      addEventListener: vi.fn(), removeEventListener: removedListener,
      ResizeObserver: class {
        constructor(callback: ConstructorParameters<typeof globalThis.ResizeObserver>[0]) { resizeCallbacks.push(callback); }
        observe = observed; unobserve = unobserved; disconnect = resizeDisconnected;
      },
      MutationObserver: class {
        constructor(callback: ConstructorParameters<typeof globalThis.MutationObserver>[0]) { mutationCallbacks.push(callback); }
        observe = vi.fn(); disconnect = mutationDisconnected;
      },
    };
    const doc = { defaultView: view, body: {}, querySelector: () => currentBar };
    const root = {
      ownerDocument: doc, getBoundingClientRect: () => paneBounds,
      style: {
        getPropertyValue: (name: string) => properties.get(name) ?? "",
        setProperty: (name: string, value: string) => properties.set(name, value),
        removeProperty: (name: string) => properties.delete(name),
      },
    };
    const flush = (): void => { const callback = pending; pending = null; callback?.(0); };
    const resize = (): void => resizeCallbacks[0]!([], {} as ResizeObserver);
    const changed = (): void => mutationCallbacks[0]!([], {} as MutationObserver);
    const dispose = reserveHostStatusBar(root as unknown as HTMLElement, (listener) => { layoutChanged = listener; return unsubscribe; });
    expect(properties.get("--cc-host-bottom-inset")).toBe("27px");
    flush();
    expect(observed).toHaveBeenCalledWith(root);
    expect(observed).toHaveBeenCalledWith(bar);

    barBounds = rect(1305, 959, 1600, 1000);
    resize(); flush();
    expect(properties.get("--cc-host-bottom-inset")).toBe("41px");
    visibility = "hidden"; changed(); flush();
    expect(properties.get("--cc-host-bottom-inset")).toBe("0px");
    visibility = "visible"; display = "none"; changed(); flush();
    expect(properties.get("--cc-host-bottom-inset")).toBe("0px");
    display = "flex";
    paneBounds = rect(340, 40, 1080, 1000);
    layoutChanged(); flush();
    expect(properties.get("--cc-host-bottom-inset")).toBe("0px");
    paneBounds = rect(1080, 40, 1600, 1000);
    currentBar = null; layoutChanged(); flush();
    expect(unobserved).toHaveBeenCalledWith(bar);
    expect(properties.get("--cc-host-bottom-inset")).toBe("0px");
    currentBar = { getBoundingClientRect: () => rect(1400, 970, 1600, 1000) };
    layoutChanged(); flush();
    expect(properties.get("--cc-host-bottom-inset")).toBe("30px");
    expect(observed).toHaveBeenCalledWith(currentBar);

    const mutationsDisconnectedBeforeClose = mutationDisconnected.mock.calls.length;
    layoutChanged(); dispose(); dispose();
    expect(cancelFrame).toHaveBeenCalledOnce();
    expect(resizeDisconnected).toHaveBeenCalledOnce();
    expect(mutationDisconnected).toHaveBeenCalledTimes(mutationsDisconnectedBeforeClose + 2);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(removedListener).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(properties.has("--cc-host-bottom-inset")).toBe(false);
    const frames = view.requestAnimationFrame.mock.calls.length;
    layoutChanged();
    expect(view.requestAnimationFrame).toHaveBeenCalledTimes(frames);
  });
});
