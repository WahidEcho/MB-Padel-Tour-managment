"use client";

/**
 * The 3D venue map: spin, tilt and zoom with fingers (or a mouse), courts in
 * their events' colours with their live match, points of interest by category,
 * the blue dot with its accuracy circle and heading, and walking navigation
 * with live re-routing. One component for the public page (/t/<slug>/map), the
 * Move Score app (the same page in a WebView, location from the app) and the
 * editor's 3D preview.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildScene, outline, ribbon, ring, wedge, rgb, VENUE_THEMES, eventColor, COURT_SLAB } from "@/lib/venue/scene";
import { bestYaw, clampCamera, fitCamera, interpolate, project, screenToGround, viewProjection, MAX_PITCH, type Camera } from "@/lib/venue/camera";
import { courtPolygon, geoToLocal, headingToPlanAngle, pointInPolygon, boundsOf } from "@/lib/venue/geo";
import { planRoute, routeStart, targetOf, type Route, type Target } from "@/lib/venue/route";
import { buildGraph } from "@/lib/venue/graph";
import { NAV_START, navStep, remainingLabel, type NavState } from "@/lib/venue/navigate";
import { formatDistance, formatDuration } from "@/lib/venue/directions";
import type { PoiCategory, Pt, VenueCourtLive, VenueDoc, VenueEvent, VenueLive } from "@/lib/venue/types";
import type { ToMap } from "@/lib/venue/bridge";
import { VenueRenderer, type Overlay } from "./renderer";
import { Icon } from "./icons";
import { inApp, postToApp, useVenueLocation, type Fix } from "./useVenueLocation";
import "./venue.css";

type MapCourt = VenueDoc["courts"][number] & { links?: { slug: string; courtId: string }[] };
export type MapDoc = Omit<VenueDoc, "courts" | "pois" | "walkways"> & {
  courts: MapCourt[];
  pois: Omit<VenueDoc["pois"][number], "survey">[];
  walkways: { nodes: Omit<VenueDoc["walkways"]["nodes"][number], "survey">[]; edges: VenueDoc["walkways"]["edges"] };
};

export interface VenueMapProps {
  doc: MapDoc;
  version?: number;
  /** The tournament the page was opened from (links, live). */
  slug?: string | null;
  liveUrl?: string | null;
  theme?: "light" | "dark" | null;
  embed?: boolean;
  /** "court:<id|number>", "poi:<id>" or "courtrow:<courts.id>". */
  focus?: string | null;
  /** The editor's preview: no location, no live polling. */
  preview?: boolean;
  className?: string;
}

const DEG = Math.PI / 180;
const BASE = { yaw: 0, pitch: 52 * DEG, fovY: 42 * DEG };

function useScheme(initial: "light" | "dark" | null | undefined): ["light" | "dark", (s: "light" | "dark") => void] {
  const [scheme, setScheme] = useState<"light" | "dark">(initial ?? "light");
  useEffect(() => {
    if (initial) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const set = () => setScheme(mq.matches ? "dark" : "light");
    set();
    mq.addEventListener("change", set);
    return () => mq.removeEventListener("change", set);
  }, [initial]);
  return [scheme, setScheme];
}

export default function VenueMap({ doc, version = 0, slug = null, liveUrl = null, theme: themeProp = null, embed = false, focus = null, preview = false, className }: VenueMapProps) {
  const [scheme, setScheme] = useScheme(themeProp);
  const theme = VENUE_THEMES[scheme];
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const dotRef = useRef<HTMLDivElement>(null);
  const renderer = useRef<VenueRenderer | null>(null);
  const cam = useRef<Camera>({ tx: 0, ty: 0, distance: 400, ...BASE });
  const anim = useRef<{ from: Camera; to: Camera; start: number; dur: number } | null>(null);
  const dirty = useRef(true);
  const [glError, setGlError] = useState<string | null>(null);
  const [yawDeg, setYawDeg] = useState(0);
  const [topDown, setTopDown] = useState(false);

  const [selected, setSelected] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [search, setSearch] = useState(false);
  const [route, setRoute] = useState<Route | null>(null);
  const [navTarget, setNavTarget] = useState<Target | null>(null);
  const [nav, setNav] = useState<NavState>(NAV_START);
  const [stepsOpen, setStepsOpen] = useState(false);
  const [follow, setFollow] = useState(false);
  const [live, setLive] = useState<Map<string, VenueCourtLive>>(new Map());
  const [notice, setNotice] = useState<string | null>(null);

  const graph = useMemo(() => buildGraph(doc as VenueDoc), [doc]);
  const scene = useMemo(() => buildScene(doc, theme), [doc, theme]);
  const bounds = scene.bounds;
  const eventsByKey = useMemo(() => new Map<string, VenueEvent>(doc.events.map((e) => [e.key, e])), [doc.events]);
  const catByKey = useMemo(() => new Map<string, PoiCategory>(doc.categories.map((c) => [c.key, c])), [doc.categories]);
  const usedCats = useMemo(() => doc.categories.filter((c) => doc.pois.some((p) => p.category === c.key)), [doc]);

  const onBridge = useCallback(
    (m: ToMap | null) => {
      if (m?.type === "theme") setScheme(m.scheme);
      if (m?.type === "focus") focusOn(m.target);
    },
    // focusOn is stable enough (reads refs); eslint cannot see through it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const fixHandler = useRef<(f: Fix) => void>(() => {});
  const onFix = useCallback((f: Fix) => fixHandler.current(f), []);
  const loc = useVenueLocation(onBridge, onFix);
  const here: Pt | null = useMemo(() => (loc.fix ? geoToLocal(doc.geo, loc.fix.lat, loc.fix.lng) : null), [loc.fix, doc.geo]);

  /* ---------------- camera ---------------- */

  const flyTo = useCallback((to: Camera, dur = 900) => {
    anim.current = { from: { ...cam.current }, to: clampCamera(to), start: performance.now(), dur };
    dirty.current = true;
  }, []);

  const size = () => ({ w: wrapRef.current?.clientWidth || 1, h: wrapRef.current?.clientHeight || 1 });

  const fitPoints = useCallback(
    (pts: Pt[], opts: { minDistance?: number; dur?: number; sheet?: boolean; pitch?: number } = {}) => {
      const { w, h } = size();
      const b = boundsOf(pts);
      const pad = 18;
      const c = fitCamera({ minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad }, w / h, { yaw: cam.current.yaw, pitch: opts.pitch ?? cam.current.pitch, fovY: BASE.fovY });
      flyTo(clearOfPanels({ ...c, distance: Math.max(opts.minDistance ?? 60, c.distance) }, opts.sheet ? 0.24 : 0.08), opts.dur);
    },
    [flyTo],
  );

  const overview = useCallback(
    (dur = 900) => {
      const { w, h } = size();
      flyTo(clearOfPanels(fitCamera(bounds, w / h, { ...BASE, yaw: bestYaw(bounds, w / h) }), 0.08, 0.2, w / h > 1), dur);
    },
    [bounds, flyTo],
  );

  /* ---------------- targets ---------------- */

  const targetFor = useCallback(
    (key: string): Target | null => {
      if (key.startsWith("courtrow:")) {
        const id = key.slice(9);
        const c = doc.courts.find((x) => x.links?.some((l) => l.courtId === id));
        return c ? targetOf(doc, `court:${c.id}`) : null;
      }
      return targetOf(doc, key);
    },
    [doc],
  );

  const select = useCallback(
    (key: string | null, fly = true) => {
      setSelected(key);
      setSearch(false);
      if (!key || !fly) return;
      const t = targetFor(key);
      if (!t) return;
      if (t.kind === "court") {
        const c = doc.courts.find((x) => x.id === t.id)!;
        fitPoints(courtPolygon(c), { minDistance: 70, sheet: true });
      } else flyTo({ ...cam.current, tx: t.point.x, ty: t.point.y, distance: 90, pitch: Math.max(cam.current.pitch, 50 * DEG) });
    },
    [doc, fitPoints, flyTo, targetFor],
  );

  // Kept in a ref so the bridge's "focus" (registered once) reaches the latest.
  const focusRef = useRef<(key: string) => void>(() => {});
  focusRef.current = (key: string) => {
    const t = targetFor(key);
    if (t) select(t.key);
  };
  function focusOn(key: string) {
    focusRef.current(key);
  }

  /* ---------------- renderer ---------------- */

  useEffect(() => {
    if (!canvasRef.current) return;
    try {
      renderer.current = new VenueRenderer(canvasRef.current, theme);
    } catch (e) {
      const text = e instanceof Error ? e.message : "WebGL is not available.";
      void Promise.resolve().then(() => setGlError(text));
      return;
    }
    const { w, h } = size();
    cam.current = clearOfPanels(fitCamera(bounds, w / h, { ...BASE, yaw: bestYaw(bounds, w / h) }), 0.08, 0.2, w / h > 1);
    return () => {
      renderer.current?.dispose();
      renderer.current = null;
    };
    // The renderer lives as long as the canvas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    renderer.current?.setTheme(theme);
    renderer.current?.setScene(scene);
    dirty.current = true;
  }, [scene, theme]);

  useEffect(() => {
    renderer.current?.setRoute(route ? ribbon(route.points, 6.4, COURT_SLAB + 0.25) : null);
    dirty.current = true;
  }, [route]);

  // Overlays: highlights, the streamed courts' halo, the accuracy circle, the heading cone.
  useEffect(() => {
    const o: Overlay[] = [];
    const accent = rgb(theme.accent);
    const streamed = doc.courts.filter((c) => c.streamed);
    if (streamed.length) {
      const tris = streamed.map((c) => outline(courtPolygon({ ...c, width: c.width + 2.4, length: c.length + 2.4 }), 1.1, 0.09));
      o.push({ tris: concat(tris), color: [accent[0], accent[1], accent[2], 0.75] });
    }
    const sel = selected ? targetFor(selected) : null;
    const hi = rgb(theme.route);
    if (sel?.kind === "court") {
      const c = doc.courts.find((x) => x.id === sel.id)!;
      o.push({ tris: outline(courtPolygon({ ...c, width: c.width + 5, length: c.length + 5 }), 1.6, 0.1), color: [hi[0], hi[1], hi[2], 0.9] });
    } else if (sel) {
      o.push({ tris: ring(sel.point, 4.2, 5.6, 0.1), color: [hi[0], hi[1], hi[2], 0.9] });
    }
    if (category) {
      for (const p of doc.pois.filter((x) => x.category === category)) {
        const cc = rgb(catByKey.get(p.category)?.color ?? "#888888");
        o.push({ tris: ring(p.point, 5, 7.5, 0.08), color: [cc[0], cc[1], cc[2], 0.55] });
      }
    }
    if (navTarget && route) {
      const end = route.points[route.points.length - 1];
      const start = route.points[0];
      const go = rgb("#12a150");
      o.push({ tris: ring(end, 0, 3.4, 0.32), color: [accent[0], accent[1], accent[2], 0.95] });
      o.push({ tris: ring(end, 4.2, 5.4, 0.31), color: [accent[0], accent[1], accent[2], 0.6] });
      o.push({ tris: ring(start, 0, 2.6, 0.32), color: [go[0], go[1], go[2], 0.95] });
    }
    if (here && loc.fix) {
      const acc = Math.max(3, loc.fix.accuracy ?? 10);
      const blue = rgb("#1a73e8");
      o.push({ tris: ring(here, 0, acc, 0.35), color: [blue[0], blue[1], blue[2], 0.16] });
      o.push({ tris: ring(here, acc - 0.4, acc, 0.36), color: [blue[0], blue[1], blue[2], 0.45] });
      if (loc.heading !== null) o.push({ tris: wedge(here, headingToPlanAngle(doc.geo, loc.heading), 16, 70 * DEG, 0.37), color: [blue[0], blue[1], blue[2], 0.28] });
    }
    renderer.current?.setOverlays(o);
    dirty.current = true;
  }, [doc, theme, selected, category, here, loc.fix, loc.heading, navTarget, route, targetFor, catByKey]);

  /* ---------------- the frame loop: GL, labels, blue dot ---------------- */

  useEffect(() => {
    let raf = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const a = anim.current;
      if (a) {
        const t = (now - a.start) / a.dur;
        cam.current = t >= 1 ? a.to : interpolate(a.from, a.to, t);
        if (t >= 1) anim.current = null;
        dirty.current = true;
      }
      if (!dirty.current && !route) return;
      dirty.current = false;
      const r = renderer.current;
      if (!r) return;
      r.render(cam.current, now / 1000);
      const { w, h } = size();
      const { viewProj } = viewProjection(cam.current, w / h);
      // Labels: one element per court and POI, moved without React.
      const layer = labelsRef.current;
      if (layer) {
        for (const el of Array.from(layer.children) as HTMLElement[]) {
          const x = Number(el.dataset.x);
          const y = Number(el.dataset.y);
          const hgt = Number(el.dataset.h ?? 0);
          const p = project(viewProj, x, y, hgt, w, h);
          if (!p || p.sx < -80 || p.sy < -40 || p.sx > w + 80 || p.sy > h + 60) {
            el.style.visibility = "hidden";
            continue;
          }
          el.style.visibility = "visible";
          el.style.transform = `translate3d(${p.sx.toFixed(1)}px, ${p.sy.toFixed(1)}px, 0) translate(-50%, -100%)`;
          el.style.zIndex = String(10000 - Math.round(p.depth));
          el.classList.toggle("vm-far", cam.current.distance > 330);
        }
      }
      const dot = dotRef.current;
      if (dot) {
        const pos = dot.dataset.x ? project(viewProj, Number(dot.dataset.x), Number(dot.dataset.y), 0.4, w, h) : null;
        dot.style.visibility = pos ? "visible" : "hidden";
        if (pos) dot.style.transform = `translate3d(${pos.sx.toFixed(1)}px, ${pos.sy.toFixed(1)}px, 0) translate(-50%, -50%)`;
      }
      const yd = Math.round((cam.current.yaw * 180) / Math.PI);
      setYawDeg((old) => (old === yd ? old : yd));
    };
    raf = requestAnimationFrame(tick);
    const ro = new ResizeObserver(() => (dirty.current = true));
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [route]);

  useEffect(() => {
    dirty.current = true;
  }, [live, selected, here, scheme]);

  /* ---------------- gestures ---------------- */

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const pts = new Map<number, { x: number; y: number }>();
    let start: { cam: Camera; inv: Float32Array | null; ground: Pt | null; dist: number; angle: number; midY: number; t: number; x: number; y: number; moved: boolean; button: number; shift: boolean } | null = null;
    const local = (e: PointerEvent | WheelEvent) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const begin = (e: PointerEvent) => {
      const { w, h } = size();
      const list = [...pts.values()];
      const vp = viewProjection(cam.current, w / h);
      const a = list[0];
      const b = list[1];
      start = {
        cam: { ...cam.current },
        inv: vp.inv,
        ground: a && vp.inv ? screenToGround(vp.inv, a.x, a.y, w, h) : null,
        dist: a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0,
        angle: a && b ? Math.atan2(b.y - a.y, b.x - a.x) : 0,
        midY: a && b ? (a.y + b.y) / 2 : 0,
        t: performance.now(),
        x: a?.x ?? 0,
        y: a?.y ?? 0,
        moved: false,
        button: e.button,
        shift: e.shiftKey || e.ctrlKey || e.altKey,
      };
    };
    const down = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest("[data-vm-ui]")) return;
      el.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, local(e));
      anim.current = null;
      begin(e);
    };
    const move = (e: PointerEvent) => {
      if (!pts.has(e.pointerId) || !start) return;
      pts.set(e.pointerId, local(e));
      const { w, h } = size();
      const list = [...pts.values()];
      if (Math.hypot(list[0].x - start.x, list[0].y - start.y) > 6) start.moved = true;
      if (!start.moved && list.length === 1) return;
      setFollow(false);
      if (list.length >= 2) {
        const [a, b] = list;
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        const midY = (a.y + b.y) / 2;
        cam.current = clampCamera({
          ...start.cam,
          distance: start.cam.distance * (start.dist / Math.max(10, d)),
          yaw: start.cam.yaw - (ang - start.angle),
          pitch: start.cam.pitch + (midY - start.midY) * 0.006,
        });
      } else if (start.button === 2 || start.shift) {
        const p = list[0];
        cam.current = clampCamera({ ...start.cam, yaw: start.cam.yaw - (p.x - start.x) * 0.008, pitch: start.cam.pitch + (p.y - start.y) * 0.006 });
      } else if (start.inv && start.ground) {
        const p = list[0];
        const g = screenToGround(start.inv, p.x, p.y, w, h);
        if (g) cam.current = { ...start.cam, tx: start.cam.tx + (start.ground.x - g.x), ty: start.cam.ty + (start.ground.y - g.y) };
      }
      dirty.current = true;
    };
    const up = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return;
      const tap = start && !start.moved && pts.size === 1 && performance.now() - start.t < 450;
      const p = pts.get(e.pointerId)!;
      pts.delete(e.pointerId);
      if (tap) onTap(p.x, p.y);
      // The remaining finger continues as a pan from here.
      if (pts.size) begin(e);
      else start = null;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      setFollow(false);
      anim.current = null;
      const { w, h } = size();
      const p = local(e);
      const before = viewProjection(cam.current, w / h).inv;
      const g0 = before ? screenToGround(before, p.x, p.y, w, h) : null;
      const next = clampCamera({ ...cam.current, distance: cam.current.distance * Math.exp(e.deltaY * 0.0015) });
      const after = viewProjection(next, w / h).inv;
      const g1 = after ? screenToGround(after, p.x, p.y, w, h) : null;
      cam.current = g0 && g1 ? { ...next, tx: next.tx + g0.x - g1.x, ty: next.ty + g0.y - g1.y } : next;
      dirty.current = true;
    };
    const menu = (e: Event) => e.preventDefault();
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("contextmenu", menu);
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("contextmenu", menu);
    };
    // onTap reads the latest doc through a ref.
  }, []);

  const tapRef = useRef<(x: number, y: number) => void>(() => {});
  tapRef.current = (x: number, y: number) => {
    const { w, h } = size();
    const inv = viewProjection(cam.current, w / h).inv;
    const g = inv ? screenToGround(inv, x, y, w, h) : null;
    if (!g) return;
    const court = doc.courts.find((c) => pointInPolygon(g, courtPolygon(c)));
    if (court) return select(`court:${court.id}`, false);
    const poi = doc.pois.find((p) => Math.hypot(p.point.x - g.x, p.point.y - g.y) < 6);
    if (poi) return select(`poi:${poi.id}`, false);
    if (!navTarget) setSelected(null);
  };
  function onTap(x: number, y: number) {
    tapRef.current(x, y);
  }

  /* ---------------- live lines ---------------- */

  useEffect(() => {
    if (preview || !liveUrl) return;
    let stop = false;
    const key = `vm:live:${slug}`;
    const fromCache = () => {
      try {
        const cached = JSON.parse(localStorage.getItem(key) ?? "null") as VenueLive | null;
        if (cached?.courts && !stop) setLive(new Map(cached.courts.map((c) => [c.courtKey, c])));
      } catch {
        /* no cache */
      }
    };
    const load = async () => {
      if (document.hidden) return;
      try {
        const r = await fetch(liveUrl, { cache: "no-store" });
        if (!r.ok) return fromCache();
        const v = (await r.json()) as VenueLive;
        if (stop) return;
        setLive(new Map(v.courts.map((c) => [c.courtKey, c])));
        try {
          localStorage.setItem(key, JSON.stringify(v));
        } catch {
          /* storage full or off */
        }
      } catch {
        // Offline: the last lines this phone saw.
        fromCache();
      }
    };
    void load();
    const t = setInterval(load, 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [liveUrl, preview, slug]);

  /* ---------------- the venue cached for offline ---------------- */

  useEffect(() => {
    if (preview || !slug) return;
    try {
      localStorage.setItem(`vm:venue:${slug}`, JSON.stringify({ version, doc }));
    } catch {
      /* fine */
    }
  }, [doc, version, slug, preview]);

  /* ---------------- focus on open ---------------- */

  useEffect(() => {
    if (!focus) return;
    const t = setTimeout(() => focusOn(focus), 350);
    return () => clearTimeout(t);
    // Once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (inApp()) postToApp({ type: "ready", version });
  }, [version]);

  /* ---------------- navigation ---------------- */

  const freshFix = loc.fix && Date.now() - loc.fix.at < 60_000 ? loc.fix : null;

  const plan = useCallback(
    (t: Target, fix: typeof freshFix) => {
      const startAt = routeStart(doc, fix);
      if (!startAt) {
        setNotice("This map has no entrance to start a route from.");
        return null;
      }
      const r = planRoute(doc, startAt, t, graph);
      if (!r) {
        setNotice(`No walkway leads to ${t.name}.`);
        return null;
      }
      return r;
    },
    [doc, graph],
  );

  const startNav = useCallback(
    (key: string) => {
      const t = targetFor(key);
      if (!t) return;
      setNotice(null);
      if (!preview && loc.status !== "on") void loc.start();
      const r = plan(t, freshFix);
      if (!r) return;
      setNavTarget(t);
      setRoute(r);
      setNav(NAV_START);
      setSelected(t.key);
      setStepsOpen(false);
      // Directions are read from above: straight down, the whole route in view.
      setTopDown(true);
      fitPoints(r.points, { minDistance: 80, sheet: true, pitch: MAX_PITCH });
    },
    [fitPoints, freshFix, loc, plan, preview, targetFor],
  );

  const endNav = useCallback(() => {
    setNavTarget(null);
    setRoute(null);
    setNav(NAV_START);
    setFollow(false);
  }, []);

  const flash = useCallback((text: string) => {
    setNotice(text);
    setTimeout(() => setNotice(null), 4000);
  }, []);

  // Each new position (from the location callback, not an effect): the first one after
  // "Centre on me", then progress along the route, re-routing when off it, arrival.
  const centredOnce = useRef(false);
  fixHandler.current = (f: Fix) => {
    const p = geoToLocal(doc.geo, f.lat, f.lng);
    if (follow && !centredOnce.current) {
      centredOnce.current = true;
      const s = routeStart(doc, f);
      if (s && s.fromEntrance && s.reason === "far_away") flash("You're not at the venue yet.");
      else flyTo({ ...cam.current, tx: p.x, ty: p.y, distance: 110 }, 800);
    }
    if (!navTarget || !route) return;
    // The first real fix after a route from the entrance: plan from the walker instead.
    if (route.start.fromEntrance) {
      const s = routeStart(doc, f);
      if (s && !s.fromEntrance) {
        const r = planRoute(doc, s, navTarget, graph);
        if (r) {
          setRoute(r);
          setNav(NAV_START);
        }
      }
      return;
    }
    const step = navStep(nav, route, p, f.accuracy);
    if (step.event === "reroute") {
      const r = plan(navTarget, f);
      if (r) {
        setRoute(r);
        setNav(NAV_START);
        flash("Off the route: here's a new one from where you are.");
      }
      return;
    }
    setNav(step.state);
    if (follow) flyTo({ ...cam.current, tx: p.x, ty: p.y }, 500);
  };

  // The blue dot's place for the frame loop.
  useEffect(() => {
    const dot = dotRef.current;
    if (!dot) return;
    if (here) {
      dot.dataset.x = String(here.x);
      dot.dataset.y = String(here.y);
    } else delete dot.dataset.x;
    dirty.current = true;
  }, [here]);

  const centreOnMe = useCallback(() => {
    if (preview) return;
    if (loc.status !== "on") {
      centredOnce.current = false;
      void loc.start();
      setFollow(true);
      return;
    }
    if (here) {
      setFollow(true);
      flyTo({ ...cam.current, tx: here.x, ty: here.y, distance: Math.min(cam.current.distance, 110) }, 700);
    }
  }, [flyTo, here, loc, preview]);

  const chooseCategory = useCallback(
    (key: string | null) => {
      setCategory(key);
      setSelected(null);
      if (key === "courts") {
        fitPoints(doc.courts.flatMap((c) => courtPolygon(c)));
        return;
      }
      if (!key) return overview();
      const pts = doc.pois.filter((p) => p.category === key);
      if (pts.length === 1) select(`poi:${pts[0].id}`);
      else if (pts.length) fitPoints(pts.map((p) => p.point), { minDistance: 90 });
    },
    [doc, fitPoints, overview, select],
  );

  /* ---------------- opening matches ---------------- */

  const openLive = useCallback(
    (l: VenueCourtLive | null, court: MapCourt) => {
      const linkSlug = l?.slug ?? court.links?.[0]?.slug ?? slug;
      if (inApp()) {
        if (l?.matchId && linkSlug) postToApp({ type: "open-match", slug: linkSlug, matchId: l.matchId });
        else if (l?.tieId && linkSlug) postToApp({ type: "open-tie", slug: linkSlug, tieId: l.tieId });
        else postToApp({ type: "open-court", slug: linkSlug ?? null, courtId: court.links?.find((x) => x.slug === linkSlug)?.courtId ?? null, name: court.name });
        return;
      }
      if (!linkSlug) return;
      window.location.href = l?.matchId ? `/t/${linkSlug}/match/${l.matchId}` : l?.tieId ? `/t/${linkSlug}/ties` : `/t/${linkSlug}/live`;
    },
    [slug],
  );

  /* ---------------- view ---------------- */

  const sel = selected ? targetFor(selected) : null;
  const selCourt = sel?.kind === "court" ? doc.courts.find((c) => c.id === sel.id) ?? null : null;
  const selPoi = sel?.kind === "poi" ? doc.pois.find((p) => p.id === sel.id) ?? null : null;
  const selLive = selCourt ? live.get(selCourt.id) ?? null : null;
  const step = route ? route.steps[Math.min(nav.progress?.stepIndex ?? 0, route.steps.length - 1)] : null;
  const remaining = route ? (nav.progress ? nav.progress.remaining : route.length) : 0;

  return (
    <div ref={wrapRef} className={`vm-root vm-${scheme}${embed ? " vm-embed" : ""} ${className ?? ""}`} data-testid="venue-map">
      <canvas ref={canvasRef} className="vm-canvas" />
      {glError && <div className="vm-glerror">This device can&apos;t draw the 3D map ({glError}).</div>}

      <div ref={labelsRef} className="vm-labels">
        {doc.courts.map((c) => {
          const l = live.get(c.id);
          const color = eventColor(doc, c.event);
          return (
            <button
              key={c.id}
              type="button"
              data-vm-ui
              data-x={c.center.x}
              data-y={c.center.y}
              data-h={2}
              className={`vm-court${selected === `court:${c.id}` ? " vm-sel" : ""}${l?.live ? " vm-islive" : ""}`}
              onClick={() => select(`court:${c.id}`, false)}
              data-testid="vm-court"
            >
              <span className="vm-court-num" style={{ background: color }}>
                {c.number}
                {c.streamed && <Icon name="camera" size={11} stroke={2.4} className="vm-cam" />}
              </span>
              {l && (
                <span className="vm-chip">
                  {l.live && <i className="vm-dot" />}
                  <b>{l.title}</b>
                  {l.detail && <span> · {l.detail}</span>}
                </span>
              )}
            </button>
          );
        })}
        {doc.pois.map((p) => {
          const cat = catByKey.get(p.category);
          return (
            <button
              key={p.id}
              type="button"
              data-vm-ui
              data-x={p.point.x}
              data-y={p.point.y}
              data-h={3}
              className={`vm-poi${category && category !== p.category && category !== "courts" ? " vm-dim" : ""}${selected === `poi:${p.id}` ? " vm-sel" : ""}`}
              style={{ background: cat?.color ?? "#555" }}
              onClick={() => select(`poi:${p.id}`, false)}
              title={p.name}
              aria-label={p.name}
            >
              <Icon name={cat?.icon ?? "pin"} size={15} stroke={2.2} />
            </button>
          );
        })}
      </div>
      <div ref={dotRef} className="vm-me" aria-label="You are here" style={{ visibility: "hidden" }}>
        <i />
      </div>

      {/* Top: sample notice, destination search, categories */}
      <div className="vm-top" data-vm-ui>
        {doc.sample && <div className="vm-sample" data-testid="vm-sample">{doc.note ?? "Sample layout — replace with the real club plan."}</div>}
        <div className="vm-searchrow">
          <button type="button" className="vm-search" onClick={() => setSearch(true)} data-testid="vm-where">
            <Icon name="search" size={17} />
            <span>{navTarget ? navTarget.name : "Where to? Courts, toilets, café…"}</span>
          </button>
        </div>
        <div className="vm-cats" role="toolbar" aria-label="Show on the map">
          <button type="button" className={`vm-cat${category === "courts" ? " vm-on" : ""}`} onClick={() => chooseCategory(category === "courts" ? null : "courts")}>
            <Icon name="court" size={15} /> Courts
          </button>
          {usedCats.map((c) => (
            <button key={c.key} type="button" className={`vm-cat${category === c.key ? " vm-on" : ""}`} onClick={() => chooseCategory(category === c.key ? null : c.key)} data-testid={`vm-cat-${c.key}`}>
              <span className="vm-cat-ico" style={{ background: c.color }}>
                <Icon name={c.icon} size={12} stroke={2.4} />
              </span>
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {/* Right: compass, 2D/3D, centre on me */}
      <div className="vm-controls" data-vm-ui>
        <button type="button" className="vm-ctl" onClick={() => flyTo({ ...cam.current, yaw: 0 }, 500)} aria-label="Point north up" title="North up">
          <span style={{ transform: `rotate(${yawDeg}deg)`, display: "inline-flex" }}>
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 2l4 10h-8z" fill="#e5484d" />
              <path d="M12 22l-4-10h8z" fill="currentColor" opacity="0.6" />
            </svg>
          </span>
        </button>
        <button
          type="button"
          className="vm-ctl vm-ctl-text"
          onClick={() => {
            setTopDown(!topDown);
            flyTo({ ...cam.current, pitch: topDown ? BASE.pitch : MAX_PITCH }, 600);
          }}
          aria-label={topDown ? "3D view" : "Top-down view"}
        >
          {topDown ? "3D" : "2D"}
        </button>
        <button type="button" className="vm-ctl" onClick={() => overview()} aria-label="Whole venue" title="Whole venue">
          <Icon name="layers" size={18} />
        </button>
        {!preview && (
          <button type="button" className={`vm-ctl${follow ? " vm-on" : ""}`} onClick={centreOnMe} aria-label="Centre on me" title="Centre on me" data-testid="vm-locate">
            <Icon name="locate" size={19} />
          </button>
        )}
      </div>

      {/* Legend */}
      <div className="vm-legend" data-vm-ui>
        {doc.events.map((e) => (
          <span key={e.key}>
            <i style={{ background: e.color }} /> {e.label}
          </span>
        ))}
        {doc.courts.some((c) => c.streamed) && (
          <span>
            <i className="vm-legend-stream" /> Streamed
          </span>
        )}
      </div>

      {notice && (
        <div className="vm-toast" data-vm-ui role="status">
          {notice}
        </div>
      )}
      {loc.status === "denied" && !notice && (
        <div className="vm-toast" data-vm-ui role="status">
          Location is off for this map. Routes start at the main entrance.
        </div>
      )}

      {/* Bottom: navigation, or the selected place */}
      {route && navTarget ? (
        <div className="vm-sheet" data-vm-ui data-testid="vm-route">
          {nav.arrived ? (
            <div className="vm-arrived">
              <Icon name="flag" size={22} />
              <div>
                <b>You&apos;ve arrived</b>
                <span>{navTarget.name}</span>
              </div>
              <button type="button" className="vm-btn" onClick={endNav}>
                Done
              </button>
            </div>
          ) : (
            <>
              <div className="vm-route-head">
                <div>
                  <div className="vm-route-sum">{remainingLabel(remaining)}</div>
                  <div className="vm-route-to">to {navTarget.name}</div>
                </div>
                <button type="button" className="vm-btn vm-btn-ghost" onClick={endNav}>
                  End
                </button>
              </div>
              {route.start.note && <div className="vm-note">{route.start.note}</div>}
              {step && (
                <div className="vm-step">
                  <Icon name={step.turn?.includes("left") ? "left" : step.turn?.includes("right") ? "right" : step.kind === "arrive" ? "flag" : "up"} size={22} />
                  <span>{step.text}</span>
                </div>
              )}
              <button type="button" className="vm-link" onClick={() => setStepsOpen(!stepsOpen)}>
                {stepsOpen ? "Hide steps" : `All ${route.steps.length} steps · ${formatDistance(route.length)} · ${formatDuration(route.seconds)}`}
              </button>
              {stepsOpen && (
                <ol className="vm-steps">
                  {route.steps.map((s, i) => (
                    <li key={i} className={i === (nav.progress?.stepIndex ?? 0) ? "vm-cur" : ""}>
                      {s.text}
                    </li>
                  ))}
                </ol>
              )}
            </>
          )}
        </div>
      ) : sel ? (
        <div className="vm-sheet" data-vm-ui data-testid="vm-card">
          <div className="vm-card-head">
            {selCourt ? (
              <span className="vm-court-num vm-big" style={{ background: eventColor(doc, selCourt.event) }}>
                {selCourt.number}
              </span>
            ) : (
              <span className="vm-poi vm-big" style={{ background: catByKey.get(selPoi?.category ?? "")?.color ?? "#555" }}>
                <Icon name={catByKey.get(selPoi?.category ?? "")?.icon ?? "pin"} size={18} />
              </span>
            )}
            <div className="vm-card-title">
              <b>{sel.name}</b>
              <span>
                {selCourt
                  ? [eventsByKey.get(selCourt.event ?? "")?.label ?? "Both events", selCourt.streamed ? "Streamed" : null].filter(Boolean).join(" · ")
                  : [catByKey.get(selPoi?.category ?? "")?.label, selPoi?.indoor ? "Indoors" : null, selPoi?.floor ? `Floor ${selPoi.floor}` : null].filter(Boolean).join(" · ")}
              </span>
            </div>
            <button type="button" className="vm-x" onClick={() => setSelected(null)} aria-label="Close">
              <Icon name="close" size={18} />
            </button>
          </div>
          {selCourt && selLive && (
            <div className="vm-live">
              {selLive.live && <i className="vm-dot" />}
              <b>{selLive.title}</b>
              {selLive.detail && <span>{selLive.detail}</span>}
            </div>
          )}
          <div className="vm-actions">
            <button type="button" className="vm-btn" onClick={() => startNav(sel.key)} data-testid="vm-directions">
              <Icon name="walk" size={17} /> Directions
            </button>
            {selCourt && !preview && (selLive || selCourt.links?.length) ? (
              <button type="button" className="vm-btn vm-btn-ghost" onClick={() => openLive(selLive, selCourt)}>
                {selLive?.matchId ? "Open match" : selLive?.tieId ? "Open tie" : "Court schedule"}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Destination search */}
      {search && (
        <div className="vm-search-sheet" data-vm-ui role="dialog" aria-label="Choose a destination">
          <div className="vm-search-head">
            <b>Where to?</b>
            <button type="button" className="vm-x" onClick={() => setSearch(false)} aria-label="Close">
              <Icon name="close" size={18} />
            </button>
          </div>
          <div className="vm-search-sec">Courts</div>
          <div className="vm-court-grid">
            {[...doc.courts].sort((a, b) => a.number - b.number).map((c) => (
              <button key={c.id} type="button" className="vm-court-pick" onClick={() => select(`court:${c.id}`)} style={{ borderColor: eventColor(doc, c.event) }}>
                <span style={{ background: eventColor(doc, c.event) }}>{c.number}</span>
                {live.get(c.id)?.live && <i className="vm-dot" />}
              </button>
            ))}
          </div>
          {usedCats.map((cat) => (
            <div key={cat.key}>
              <div className="vm-search-sec">{cat.label}</div>
              {doc.pois
                .filter((p) => p.category === cat.key)
                .map((p) => (
                  <button key={p.id} type="button" className="vm-place" onClick={() => select(`poi:${p.id}`)}>
                    <span className="vm-cat-ico" style={{ background: cat.color }}>
                      <Icon name={cat.icon} size={12} stroke={2.4} />
                    </span>
                    {p.name}
                  </button>
                ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The map's top panel (search, categories) and a bottom sheet cover part of the
 * screen: zoom out to make room and move what was fitted into the clear band.
 */
function clearOfPanels(c: Camera, bottom: number, top = 0.2, zoomOut = true): Camera {
  const free = Math.max(0.4, 1 - top - bottom);
  const distance = zoomOut ? c.distance / free : c.distance;
  // Ground depth seen on screen, roughly; the target moves toward the camera so the content rises.
  const depth = (2 * distance * Math.tan(c.fovY / 2)) / Math.max(0.35, Math.sin(c.pitch));
  const shift = ((bottom - top) / 2) * depth * 0.9;
  return clampCamera({ ...c, distance, tx: c.tx - Math.sin(c.yaw) * shift, ty: c.ty - Math.cos(c.yaw) * shift });
}

function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
