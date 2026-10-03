/**
 * Counts the images an export is waiting for (photo, flags, wordmark), so the
 * story is captured only once every one of them has drawn: never a story with
 * a blank flag or a half-decoded photo.
 */
import { createContext, useContext, useLayoutEffect, useMemo, useRef } from "react";

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
