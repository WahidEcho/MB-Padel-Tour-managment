/**
 * Counts the images an export is waiting for (photo, flags, wordmark), so the
 * story is captured only once every one of them has drawn: never a story with
 * a blank flag or a half-decoded photo.
 */
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef } from "react";
import type { LayoutChangeEvent } from "react-native";

export class LoadGate {
  private pending = new Set<number>();
  private next = 0;
  private waiters: (() => void)[] = [];

  add(): number {
    const id = this.next++;
    this.pending.add(id);
    return id;
  }

  done(id: number) {
    if (!this.pending.delete(id) || this.pending.size) return;
    const w = this.waiters;
    this.waiters = [];
    w.forEach((f) => f());
  }

  /** Resolves when every registered image has loaded (or failed), or after `timeoutMs`. */
  settled(timeoutMs: number): Promise<void> {
    if (!this.pending.size) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      this.waiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

const Ctx = createContext<LoadGate | null>(null);
export const LoadGateProvider = Ctx.Provider;

/**
 * onLayout for a box the export must not capture before it has its real size
 * (the sticker): the gate holds until the box has been laid out with a height.
 */
export function useGatedLayout(gate: LoadGate): (e: LayoutChangeEvent) => void {
  const id = useRef<number | null>(null);
  useLayoutEffect(() => {
    const mine = gate.add();
    id.current = mine;
    return () => {
      id.current = null;
      gate.done(mine);
    };
  }, [gate]);
  return useCallback(
    (e: LayoutChangeEvent) => {
      if (id.current === null || e.nativeEvent.layout.height <= 0) return;
      gate.done(id.current);
      id.current = null;
    },
    [gate],
  );
}

/** onLoad / onError for one image; a no-op outside an export. */
export function useGatedImage(): { onLoad?: () => void; onError?: () => void } {
  const gate = useContext(Ctx);
  const id = useRef<number | null>(null);
  // A layout effect runs before the export's own (passive) effect asks the gate to settle.
  useLayoutEffect(() => {
    if (!gate) return;
    const mine = gate.add();
    id.current = mine;
    return () => {
      id.current = null;
      gate.done(mine);
    };
  }, [gate]);
  return useMemo(() => {
    if (!gate) return {};
    const finish = () => {
      if (id.current !== null) gate.done(id.current);
    };
    return { onLoad: finish, onError: finish };
  }, [gate]);
}
