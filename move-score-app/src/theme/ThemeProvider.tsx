import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useColorScheme } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { DARK, LIGHT, skinned, type Palette, type SkinSeeds } from "./palette";
import { createStore } from "../state/store";
import { getJson, setJson } from "../state/kv";

export type ModePref = "system" | "dark" | "light";
export const themePref = createStore<{ mode: ModePref; calm: boolean }>(getJson("ms.theme", { mode: "system" as ModePref, calm: false }));
themePref.subscribe(() => setJson("ms.theme", themePref.get()));

interface ThemeValue {
  t: Palette;
  /** Motion should be reduced: the system setting or the app's own switch. */
  calm: boolean;
}

const Ctx = createContext<ThemeValue>({ t: DARK, calm: false });

function resolve(pref: ModePref, system: string | null | undefined, skinMode?: "dark" | "light" | null): Palette {
  const mode = pref !== "system" ? pref : (skinMode ?? (system === "light" ? "light" : "dark"));
  return mode === "light" ? LIGHT : DARK;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme();
  const reduced = useReducedMotion();
  const pref = themePref.use((s) => s);
  const value = useMemo(() => ({ t: resolve(pref.mode, system), calm: pref.calm || reduced }), [pref, system, reduced]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** A tournament's pages: the same theme recoloured with the event's skin. */
export function SkinScope({ skin, children }: { skin: (SkinSeeds & { mode?: "dark" | "light" | null }) | null | undefined; children: ReactNode }) {
  const outer = useContext(Ctx);
  const system = useColorScheme();
  const pref = themePref.use((s) => s.mode);
  const value = useMemo(() => {
    const base = resolve(pref, system, skin?.mode ?? null);
    return { ...outer, t: skinned(base, skin) };
  }, [outer, pref, system, skin]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeValue {
  return useContext(Ctx);
}

/** Forces dark or light below it: the referee's sunlight mode. */
export function SchemeScope({ scheme, children }: { scheme: "dark" | "light" | null; children: ReactNode }) {
  const outer = useContext(Ctx);
  const value = useMemo(() => (scheme ? { ...outer, t: scheme === "light" ? LIGHT : DARK } : outer), [outer, scheme]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
