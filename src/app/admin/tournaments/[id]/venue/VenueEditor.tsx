"use client";

/**
 * The venue map editor (2D): the site plan underneath (an aerial image, or a
 * DXF / SVG plan with its layers), courts, buildings, walkway lines and points
 * of interest placed and dragged on it, the anchor, warnings, JSON import /
 * export and a 3D preview. Saving goes through saveVenueAction, which reads
 * the document again strictly (src/lib/venue/validate.ts).
 */
import { useCallback, useMemo, useRef, useState, useTransition } from "react";
import dynamic from "next/dynamic";
import { courtPolygon, centroid } from "@/lib/venue/geo";
import { parseVenue, venueWarnings } from "@/lib/venue/validate";
import { parseDxf, planPoints } from "@/lib/venue/dxf";
import { linkCourts, type CourtRow } from "@/lib/venue/public";
import { emptyVenue } from "@/lib/venue/sample";
import { eventColor } from "@/lib/venue/scene";
import type { Pt, VenueBuilding, VenueCourt, VenueDoc, VenuePoi, VenueUnderlay, WalkNode } from "@/lib/venue/types";
import type { FormState } from "@/lib/refusal";
import { loadSampleVenueAction, saveUnderlayAction, saveVenueAction, uploadUnderlayImageAction } from "./actions";
import { parseSvgPlan } from "@/components/venue/svgPlan";

const VenueMap = dynamic(() => import("@/components/venue/VenueMap"), { ssr: false });

type Tool = "select" | "court" | "poi" | "node" | "connect" | "building" | "delete" | "underlay";
type Sel = { kind: "court" | "poi" | "node" | "building"; id: string } | { kind: "edge"; a: string; b: string } | null;

const TOOLS: [Tool, string, string][] = [
  ["select", "Select / move", "Drag courts, points, buildings and walkway points. Drag empty space to pan; scroll to zoom."],
  ["court", "Add court", "Click to place a court (18 × 36 m) of the chosen event."],
  ["poi", "Add point", "Click to place a point of interest of the chosen category."],
  ["node", "Walkway", "Click to add a walkway point; it joins the selected point, so clicks draw a path. Esc ends the path."],
  ["connect", "Join points", "Click two walkway points to join them."],
  ["building", "Building", "Click the corners; Finish building when done."],
  ["delete", "Delete", "Click anything to delete it (a walkway point takes its lines with it)."],
  ["underlay", "Move plan", "Drag the site plan under the drawing."],
];

let seq = 0;
const newId = (prefix: string, taken: Set<string>) => {
  let id = "";
  do id = `${prefix}${Date.now().toString(36).slice(-4)}${(seq++).toString(36)}`;
  while (taken.has(id));
  return id;
};
const r2 = (v: number) => Math.round(v * 100) / 100;

export default function VenueEditor({
  tournamentId,
  initialDoc,
  initialUnderlay,
  published: initialPublished,
  version,
  courtRows,
  slugs,
}: {
  tournamentId: string;
  initialDoc: VenueDoc | null;
  initialUnderlay: VenueUnderlay | null;
  published: boolean;
  version: number;
  courtRows: CourtRow[];
  slugs: string[];
}) {
  const [doc, setDoc] = useState<VenueDoc>(initialDoc ?? emptyVenue());
  const [underlay, setUnderlay] = useState<VenueUnderlay | null>(initialUnderlay);
  const [published, setPublished] = useState(initialPublished);
  const [tool, setTool] = useState<Tool>("select");
  const [sel, setSel] = useState<Sel>(null);
  const [poiCat, setPoiCat] = useState(doc.categories[0]?.key ?? "toilets");
  const [courtEvent, setCourtEvent] = useState<string>(doc.events[0]?.key ?? "");
  const [drawing, setDrawing] = useState<Pt[]>([]);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [view, setView] = useState({ k: 2.2, ox: 120, oy: 520 });
  const [msg, setMsg] = useState<FormState>(null);
  const [planMsg, setPlanMsg] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [json, setJson] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [pending, start] = useTransition();
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ kind: string; id?: string; from: Pt; orig: unknown; screen?: { x: number; y: number; ox: number; oy: number } } | null>(null);

  const change = useCallback((fn: (d: VenueDoc) => VenueDoc) => {
    setDoc((d) => fn(structuredClone(d)));
    setDirty(true);
  }, []);

  const ids = useMemo(() => new Set([...doc.courts.map((c) => c.id), ...doc.pois.map((p) => p.id), ...doc.buildings.map((b) => b.id), ...doc.walkways.nodes.map((n) => n.id)]), [doc]);
  const warnings = useMemo(() => venueWarnings(doc, courtRows), [doc, courtRows]);
  const problems = useMemo(() => parseVenue(JSON.parse(JSON.stringify(doc))).problems, [doc]);
  const nodesById = useMemo(() => new Map(doc.walkways.nodes.map((n) => [n.id, n])), [doc.walkways.nodes]);

  /* ---------------- view ---------------- */

  const toPlan = (e: { clientX: number; clientY: number }): Pt => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left - view.ox) / view.k, y: -(e.clientY - r.top - view.oy) / view.k };
  };

  const fitView = useCallback(() => {
    const pts = [...doc.courts.flatMap((c) => courtPolygon(c)), ...doc.buildings.flatMap((b) => b.polygon), ...doc.walkways.nodes, ...doc.pois.map((p) => p.point)];
    const r = svgRef.current?.getBoundingClientRect();
    if (!pts.length || !r) return;
    const minX = Math.min(...pts.map((p) => p.x));
    const maxX = Math.max(...pts.map((p) => p.x));
    const minY = Math.min(...pts.map((p) => p.y));
    const maxY = Math.max(...pts.map((p) => p.y));
    const k = Math.min(r.width / (maxX - minX + 40), r.height / (maxY - minY + 40));
    setView({ k, ox: r.width / 2 - ((minX + maxX) / 2) * k, oy: r.height / 2 + ((minY + maxY) / 2) * k });
  }, [doc]);

  /* ---------------- pointer ---------------- */

  const onDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const target = (e.target as Element).closest("[data-kind]") as SVGElement | null;
    const kind = target?.dataset.kind;
    const id = target?.dataset.id;
    const p = toPlan(e);
    svgRef.current?.setPointerCapture(e.pointerId);

    if (tool === "delete" && kind) {
      change((d) => {
        if (kind === "court") d.courts = d.courts.filter((c) => c.id !== id);
        if (kind === "poi") d.pois = d.pois.filter((x) => x.id !== id);
        if (kind === "building") d.buildings = d.buildings.filter((x) => x.id !== id);
        if (kind === "node") {
          d.walkways.nodes = d.walkways.nodes.filter((n) => n.id !== id);
          d.walkways.edges = d.walkways.edges.filter((x) => x.a !== id && x.b !== id);
        }
        if (kind === "edge") {
          const [a, b] = (id ?? "").split("|");
          d.walkways.edges = d.walkways.edges.filter((x) => !((x.a === a && x.b === b) || (x.a === b && x.b === a)));
        }
        return d;
      });
      setSel(null);
      return;
    }
    if (tool === "court") {
      const nid = newId("court", ids);
      const number = Math.max(0, ...doc.courts.map((c) => c.number)) + 1;
      const court: VenueCourt = { id: nid, number, name: `Court ${number}`, event: courtEvent || null, center: { x: r2(p.x), y: r2(p.y) }, width: 18, length: 36, angleDeg: 0, surface: "hard" };
      change((d) => ({ ...d, courts: [...d.courts, court] }));
      setSel({ kind: "court", id: nid });
      return;
    }
    if (tool === "poi") {
      const nid = newId("poi", ids);
      const cat = doc.categories.find((c) => c.key === poiCat);
      const poi: VenuePoi = { id: nid, category: poiCat, name: cat?.label ?? "Point", point: { x: r2(p.x), y: r2(p.y) } };
      change((d) => ({ ...d, pois: [...d.pois, poi] }));
      setSel({ kind: "poi", id: nid });
      return;
    }
    if (tool === "node") {
      if (kind === "node" && id) {
        // Clicking an existing point joins it to the path and continues from it.
        if (sel?.kind === "node" && sel.id !== id) change((d) => ({ ...d, walkways: { ...d.walkways, edges: [...d.walkways.edges, { a: sel.id, b: id }] } }));
        setSel({ kind: "node", id });
        return;
      }
      const nid = newId("n", ids);
      const node: WalkNode = { id: nid, x: r2(p.x), y: r2(p.y) };
      const prev = sel?.kind === "node" ? sel.id : null;
      change((d) => ({ ...d, walkways: { nodes: [...d.walkways.nodes, node], edges: prev ? [...d.walkways.edges, { a: prev, b: nid }] : d.walkways.edges } }));
      setSel({ kind: "node", id: nid });
      return;
    }
    if (tool === "connect") {
      if (kind !== "node" || !id) return;
      if (!connectFrom) setConnectFrom(id);
      else {
        if (connectFrom !== id) change((d) => ({ ...d, walkways: { ...d.walkways, edges: [...d.walkways.edges, { a: connectFrom, b: id }] } }));
        setConnectFrom(null);
      }
      return;
    }
    if (tool === "building") {
      setDrawing((pts) => [...pts, { x: r2(p.x), y: r2(p.y) }]);
      return;
    }
    if (tool === "underlay" && underlay) {
      drag.current = { kind: "underlay", from: p, orig: { ...underlay.center } };
      return;
    }
    // Select / move.
    if (kind && id && kind !== "edge") {
      setSel({ kind: kind as "court" | "poi" | "node" | "building", id });
      const orig =
        kind === "court" ? doc.courts.find((c) => c.id === id)?.center : kind === "poi" ? doc.pois.find((x) => x.id === id)?.point : kind === "node" ? nodesById.get(id) : doc.buildings.find((b) => b.id === id)?.polygon;
      drag.current = { kind, id, from: p, orig: structuredClone(orig) };
      return;
    }
    if (kind === "edge" && id) {
      const [a, b] = id.split("|");
      setSel({ kind: "edge", a, b });
      return;
    }
    setSel(null);
    drag.current = { kind: "pan", from: p, orig: null, screen: { x: e.clientX, y: e.clientY, ox: view.ox, oy: view.oy } };
  };

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const d0 = drag.current;
    if (!d0) return;
    if (d0.kind === "pan" && d0.screen) {
      const s = d0.screen;
      setView((v) => ({ ...v, ox: s.ox + e.clientX - s.x, oy: s.oy + e.clientY - s.y }));
      return;
    }
    const p = toPlan(e);
    const dx = r2(p.x - d0.from.x);
    const dy = r2(p.y - d0.from.y);
    if (d0.kind === "underlay") {
      const o = d0.orig as Pt;
      setUnderlay((u) => (u ? { ...u, center: { x: r2(o.x + dx), y: r2(o.y + dy) } } : u));
      return;
    }
    change((d) => {
      if (d0.kind === "court") {
        const c = d.courts.find((x) => x.id === d0.id);
        const o = d0.orig as Pt;
        if (c) c.center = { x: r2(o.x + dx), y: r2(o.y + dy) };
      } else if (d0.kind === "poi") {
        const x = d.pois.find((q) => q.id === d0.id);
        const o = d0.orig as Pt;
        if (x) x.point = { x: r2(o.x + dx), y: r2(o.y + dy) };
      } else if (d0.kind === "node") {
        const n = d.walkways.nodes.find((q) => q.id === d0.id);
        const o = d0.orig as Pt;
        if (n) {
          n.x = r2(o.x + dx);
          n.y = r2(o.y + dy);
        }
      } else if (d0.kind === "building") {
        const b = d.buildings.find((q) => q.id === d0.id);
        const o = d0.orig as Pt[];
        if (b) b.polygon = o.map((q) => ({ x: r2(q.x + dx), y: r2(q.y + dy) }));
      }
      return d;
    });
  };

  const onUp = () => {
    drag.current = null;
  };

  const onWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    const r = svgRef.current!.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const f = Math.exp(-e.deltaY * 0.0015);
    setView((v) => {
      const k = Math.min(40, Math.max(0.2, v.k * f));
      return { k, ox: sx - ((sx - v.ox) * k) / v.k, oy: sy - ((sy - v.oy) * k) / v.k };
    });
  };

  const finishBuilding = () => {
    if (drawing.length < 3) return setDrawing([]);
    const nid = newId("b", ids);
    const b: VenueBuilding = { id: nid, name: "Building", kind: "building", polygon: drawing, height: 5 };
    change((d) => ({ ...d, buildings: [...d.buildings, b] }));
    setDrawing([]);
    setSel({ kind: "building", id: nid });
  };

  /* ---------------- saving ---------------- */

  const save = () => {
    const f = new FormData();
    f.set("tournament_id", tournamentId);
    f.set("doc", JSON.stringify(doc));
    if (published) f.set("published", "on");
    start(async () => {
      const r = await saveVenueAction(null, f);
      setMsg(r);
      if (r?.ok) setDirty(false);
    });
  };

  const loadSample = () => {
    if (!window.confirm("Replace the whole venue with the sample layout?")) return;
    const f = new FormData();
    f.set("tournament_id", tournamentId);
    start(async () => {
      const r = await loadSampleVenueAction(null, f);
      setMsg(r);
      if (r?.ok) window.location.reload();
    });
  };

  const saveUnderlay = (u: VenueUnderlay | null) => {
    const f = new FormData();
    f.set("tournament_id", tournamentId);
    let payload = u;
    // A big plan keeps only the layers that are switched on.
    if (u?.kind === "vector" && JSON.stringify(u).length > 6_500_000) payload = { ...u, layers: u.layers.filter((l) => l.visible) };
    f.set("underlay", payload ? JSON.stringify(payload) : "");
    start(async () => {
      const r = await saveUnderlayAction(null, f);
      setPlanMsg(r?.message ?? null);
    });
  };

  const uploadImage = (file: File) => {
    const f = new FormData();
    f.set("tournament_id", tournamentId);
    f.set("file", file);
    start(async () => {
      const r = await uploadUnderlayImageAction(null, f);
      setPlanMsg(r?.message ?? null);
      if (r?.ok) window.location.reload();
    });
  };

  const importPlan = async (file: File) => {
    setPlanMsg(null);
    try {
      const text = await file.text();
      const isSvg = /\.svg$/i.test(file.name) || text.trimStart().startsWith("<");
      const plan = isSvg ? parseSvgPlan(text) : parseDxf(text);
      const center = doc.courts.length ? centroid(doc.courts.map((c) => c.center)) : { x: 0, y: 0 };
      setUnderlay({
        kind: "vector",
        source: isSvg ? "svg" : "dxf",
        fileName: file.name.slice(0, 120),
        units: plan.units,
        bounds: plan.bounds,
        layers: plan.layers,
        center,
        rotationDeg: 0,
        scale: plan.metresPerUnit,
        opacity: 0.8,
      });
      const skipped = Object.entries(plan.skipped).map(([k, v]) => `${v} ${k}`).join(", ");
      setPlanMsg(`${file.name}: ${plan.layers.length} layers, ${planPoints(plan.layers).toLocaleString("en")} points, ${plan.units}${skipped ? ` (skipped ${skipped})` : ""}. Place it, pick the layers, then Save site plan.`);
    } catch (e) {
      setPlanMsg(e instanceof Error ? e.message : "Could not read that plan.");
    }
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${(doc.name || "venue").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.venue.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importJson = (text: string) => {
    try {
      const parsed = parseVenue(JSON.parse(text));
      if (!parsed.doc) throw new Error(parsed.problems.join(" "));
      setDoc(parsed.doc);
      setDirty(true);
      setJson(null);
      setMsg({ ok: parsed.ok, message: parsed.ok ? "Imported. Check it, then Save." : `Imported with problems: ${parsed.problems.slice(0, 3).join(" ")}` });
      setTimeout(fitView, 50);
    } catch (e) {
      setMsg({ ok: false, message: e instanceof Error ? e.message : "Not a venue file." });
    }
  };

  /* ---------------- selection ---------------- */

  const selCourt = sel?.kind === "court" ? doc.courts.find((c) => c.id === sel.id) : undefined;
  const selPoi = sel?.kind === "poi" ? doc.pois.find((p) => p.id === sel.id) : undefined;
  const selNode = sel?.kind === "node" ? nodesById.get(sel.id) : undefined;
  const selBuilding = sel?.kind === "building" ? doc.buildings.find((b) => b.id === sel.id) : undefined;
  const edit = <T,>(list: "courts" | "pois" | "buildings", id: string, patch: Partial<T>) =>
    change((d) => {
      const arr = d[list] as unknown as ({ id: string } & T)[];
      const i = arr.findIndex((x) => x.id === id);
      if (i >= 0) arr[i] = { ...arr[i], ...patch };
      return d;
    });

  const previewDoc = useMemo(() => ({ ...doc, courts: linkCourts(doc, courtRows) }), [doc, courtRows]);
  const T = view;
  const strokeW = 1 / T.k;

  return (
    <div className="space-y-3" data-testid="venue-editor">
      {doc.sample && <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm font-semibold text-warning">{doc.note ?? "Sample layout — replace with the real club plan."}</p>}

      <div className="card flex flex-wrap items-center gap-2 py-2">
        {TOOLS.map(([t, label, help]) => (
          <button key={t} type="button" title={help} onClick={() => { setTool(t); setConnectFrom(null); if (t !== "building") setDrawing([]); }} className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${tool === t ? "bg-foreground text-background" : "bg-card text-muted hover:text-foreground"}`} data-testid={`venue-tool-${t}`}>
            {label}
          </button>
        ))}
        {tool === "poi" && (
          <select className="input w-auto text-xs" value={poiCat} onChange={(e) => setPoiCat(e.target.value)} aria-label="Category">
            {doc.categories.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        )}
        {tool === "court" && (
          <select className="input w-auto text-xs" value={courtEvent} onChange={(e) => setCourtEvent(e.target.value)} aria-label="Event">
            <option value="">Both events</option>
            {doc.events.map((ev) => (
              <option key={ev.key} value={ev.key}>
                {ev.label}
              </option>
            ))}
          </select>
        )}
        {tool === "building" && (
          <button type="button" className="btn-secondary text-xs" onClick={finishBuilding} disabled={drawing.length < 3}>
            Finish building ({drawing.length} corners)
          </button>
        )}
        <span className="ml-auto flex gap-2">
          <button type="button" className="btn-secondary text-xs" onClick={fitView}>
            Fit
          </button>
          <button type="button" className="btn-secondary text-xs" onClick={() => setPreview(!preview)} data-testid="venue-preview-toggle">
            {preview ? "Back to 2D" : "3D preview"}
          </button>
        </span>
      </div>
      <p className="text-xs text-muted">{TOOLS.find(([t]) => t === tool)?.[2]}</p>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="card overflow-hidden p-0" style={{ height: 620 }}>
          {preview ? (
            <VenueMap doc={previewDoc} preview />
          ) : (
            <svg
              ref={svgRef}
              className="h-full w-full touch-none select-none"
              style={{ background: "var(--color-card, #f6f7f9)", cursor: tool === "select" ? "grab" : "crosshair" }}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
              onWheel={onWheel}
              onKeyDown={(e) => e.key === "Escape" && setSel(null)}
              tabIndex={0}
              data-testid="venue-canvas"
            >
              <g transform={`matrix(${T.k} 0 0 ${-T.k} ${T.ox} ${T.oy})`}>
                {underlay?.kind === "image" && (
                  <g transform={`translate(${underlay.center.x} ${underlay.center.y}) rotate(${underlay.rotationDeg}) scale(${underlay.scale} ${-underlay.scale})`} opacity={underlay.opacity} pointerEvents="none">
                    {/* The underlay is the organiser's own upload (stored in the media bucket). */}
                    <image href={underlay.url} x={-underlay.width / 2} y={-underlay.height / 2} width={underlay.width} height={underlay.height} preserveAspectRatio="none" />
                  </g>
                )}
                {underlay?.kind === "vector" && (
                  <g
                    transform={`translate(${underlay.center.x} ${underlay.center.y}) rotate(${underlay.rotationDeg}) scale(${underlay.scale}) translate(${-(underlay.bounds.minX + underlay.bounds.maxX) / 2} ${-(underlay.bounds.minY + underlay.bounds.maxY) / 2})`}
                    opacity={underlay.opacity}
                    pointerEvents="none"
                    data-testid="venue-plan"
                  >
                    {underlay.layers.filter((l) => l.visible).map((l) => (
                      <g key={l.name} stroke={l.color} fill="none" strokeWidth={1} vectorEffect="non-scaling-stroke">
                        {l.lines.map((line, i) => (
                          <polyline key={i} points={line.join(" ")} vectorEffect="non-scaling-stroke" />
                        ))}
                      </g>
                    ))}
                  </g>
                )}
                {doc.boundary && <polygon points={doc.boundary.map((p) => `${p.x},${p.y}`).join(" ")} fill="rgba(80,160,90,0.08)" stroke="rgba(80,160,90,0.6)" strokeWidth={strokeW} />}
                {doc.buildings.map((b) => (
                  <polygon
                    key={b.id}
                    data-kind="building"
                    data-id={b.id}
                    points={b.polygon.map((p) => `${p.x},${p.y}`).join(" ")}
                    fill={b.kind === "area" ? "rgba(120,130,140,0.25)" : b.kind === "stand" ? "rgba(110,125,150,0.55)" : "rgba(90,100,120,0.45)"}
                    stroke={sel?.kind === "building" && sel.id === b.id ? "#1a73e8" : "#5a6478"}
                    strokeWidth={strokeW * (sel?.kind === "building" && sel.id === b.id ? 3 : 1)}
                  />
                ))}
                {doc.walkways.edges.map((e) => {
                  const a = nodesById.get(e.a);
                  const b = nodesById.get(e.b);
                  if (!a || !b) return null;
                  const on = sel?.kind === "edge" && ((sel.a === e.a && sel.b === e.b) || (sel.a === e.b && sel.b === e.a));
                  return (
                    <g key={`${e.a}|${e.b}`}>
                      <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={on ? "#1a73e8" : "#c9a227"} strokeWidth={3.2} strokeLinecap="round" opacity={0.85} />
                      <line data-kind="edge" data-id={`${e.a}|${e.b}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="transparent" strokeWidth={Math.max(4, 12 / T.k)} />
                    </g>
                  );
                })}
                {doc.courts.map((c) => {
                  const poly = courtPolygon(c);
                  const on = sel?.kind === "court" && sel.id === c.id;
                  return (
                    <g key={c.id} data-kind="court" data-id={c.id}>
                      <polygon points={poly.map((p) => `${p.x},${p.y}`).join(" ")} fill={eventColor(doc, c.event)} fillOpacity={0.55} stroke={on ? "#1a73e8" : c.streamed ? "#e5484d" : "#244"} strokeWidth={strokeW * (on || c.streamed ? 3 : 1)} />
                      <text x={c.center.x} y={-c.center.y} transform="scale(1 -1)" textAnchor="middle" dominantBaseline="middle" fontSize={8} fontWeight={800} fill="#fff" pointerEvents="none">
                        {c.number}
                      </text>
                    </g>
                  );
                })}
                {doc.walkways.nodes.map((n) => (
                  <circle key={n.id} data-kind="node" data-id={n.id} cx={n.x} cy={n.y} r={Math.max(1.4, 5 / T.k)} fill={(sel?.kind === "node" && sel.id === n.id) || connectFrom === n.id ? "#1a73e8" : n.survey ? "#12a150" : "#8a6d00"} stroke="#fff" strokeWidth={strokeW} />
                ))}
                {doc.pois.map((p) => {
                  const cat = doc.categories.find((c) => c.key === p.category);
                  const on = sel?.kind === "poi" && sel.id === p.id;
                  return (
                    <g key={p.id} data-kind="poi" data-id={p.id}>
                      <circle cx={p.point.x} cy={p.point.y} r={Math.max(2.5, 9 / T.k)} fill={cat?.color ?? "#555"} stroke={on ? "#1a73e8" : "#fff"} strokeWidth={strokeW * (on ? 3 : 1.5)} />
                      {p.main && <circle cx={p.point.x} cy={p.point.y} r={Math.max(4, 14 / T.k)} fill="none" stroke={cat?.color ?? "#555"} strokeWidth={strokeW * 2} />}
                      <text x={p.point.x} y={-p.point.y - Math.max(4, 13 / T.k)} transform="scale(1 -1)" textAnchor="middle" fontSize={11 / T.k} fill="currentColor" pointerEvents="none">
                        {p.name}
                      </text>
                    </g>
                  );
                })}
                {drawing.length > 0 && <polyline points={drawing.map((p) => `${p.x},${p.y}`).join(" ")} fill="rgba(26,115,232,0.15)" stroke="#1a73e8" strokeWidth={strokeW * 2} />}
                <g pointerEvents="none" opacity={0.7}>
                  <line x1={0} y1={0} x2={10} y2={0} stroke="#e5484d" strokeWidth={strokeW * 2} />
                  <line x1={0} y1={0} x2={0} y2={10} stroke="#12a150" strokeWidth={strokeW * 2} />
                </g>
              </g>
              <text x={10} y={18} fontSize={11} fill="currentColor" opacity={0.6} pointerEvents="none">
                {`${(100 / T.k).toFixed(0)} m per 100 px · origin = anchor (red x, green y = plan north)`}
              </text>
            </svg>
          )}
        </div>

        <div className="space-y-3">
          {/* Selection */}
          <section className="card space-y-2 text-sm" data-testid="venue-props">
            <h3 className="font-bold">{sel ? "Selected" : "Nothing selected"}</h3>
            {selCourt && (
              <div className="grid grid-cols-2 gap-2">
                <label className="col-span-2">
                  Name (as in the event&apos;s courts)
                  <input className="input" value={selCourt.name} onChange={(e) => edit<VenueCourt>("courts", selCourt.id, { name: e.target.value })} />
                </label>
                <label>
                  Number
                  <input className="input" type="number" value={selCourt.number} onChange={(e) => edit<VenueCourt>("courts", selCourt.id, { number: Number(e.target.value) })} />
                </label>
                <label>
                  Event
                  <select className="input" value={selCourt.event ?? ""} onChange={(e) => edit<VenueCourt>("courts", selCourt.id, { event: e.target.value || null })}>
                    <option value="">Both</option>
                    {doc.events.map((ev) => (
                      <option key={ev.key} value={ev.key}>
                        {ev.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Angle °
                  <input className="input" type="number" step={1} value={selCourt.angleDeg} onChange={(e) => edit<VenueCourt>("courts", selCourt.id, { angleDeg: Number(e.target.value) })} />
                </label>
                <label className="flex items-end gap-2">
                  <input type="checkbox" checked={Boolean(selCourt.streamed)} onChange={(e) => edit<VenueCourt>("courts", selCourt.id, { streamed: e.target.checked || undefined })} /> Streamed
                </label>
                <label>
                  Width m
                  <input className="input" type="number" value={selCourt.width} onChange={(e) => edit<VenueCourt>("courts", selCourt.id, { width: Number(e.target.value) })} />
                </label>
                <label>
                  Length m
                  <input className="input" type="number" value={selCourt.length} onChange={(e) => edit<VenueCourt>("courts", selCourt.id, { length: Number(e.target.value) })} />
                </label>
                <button
                  type="button"
                  className="btn-secondary col-span-2 text-xs"
                  onClick={() => {
                    const nid = newId("court", ids);
                    const number = Math.max(...doc.courts.map((c) => c.number)) + 1;
                    const step = { x: Math.cos((selCourt.angleDeg * Math.PI) / 180) * (selCourt.width + 0.01), y: Math.sin((selCourt.angleDeg * Math.PI) / 180) * (selCourt.width + 0.01) };
                    change((d) => ({ ...d, courts: [...d.courts, { ...selCourt, id: nid, number, name: `Court ${number}`, center: { x: r2(selCourt.center.x + step.x), y: r2(selCourt.center.y + step.y) }, streamed: undefined, survey: undefined }] }));
                    setSel({ kind: "court", id: nid });
                  }}
                >
                  Duplicate beside it
                </button>
                {selCourt.survey && <p className="col-span-2 text-xs text-success">Surveyed ±{selCourt.survey.accuracy} m ({selCourt.survey.mode})</p>}
              </div>
            )}
            {selPoi && (
              <div className="grid grid-cols-2 gap-2">
                <label className="col-span-2">
                  Name
                  <input className="input" value={selPoi.name} onChange={(e) => edit<VenuePoi>("pois", selPoi.id, { name: e.target.value })} />
                </label>
                <label className="col-span-2">
                  Category
                  <select className="input" value={selPoi.category} onChange={(e) => edit<VenuePoi>("pois", selPoi.id, { category: e.target.value })}>
                    {doc.categories.map((c) => (
                      <option key={c.key} value={c.key}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={Boolean(selPoi.indoor)} onChange={(e) => edit<VenuePoi>("pois", selPoi.id, { indoor: e.target.checked || undefined })} /> Indoors
                </label>
                <label>
                  Floor
                  <input className="input" type="number" value={selPoi.floor ?? ""} onChange={(e) => edit<VenuePoi>("pois", selPoi.id, { floor: e.target.value === "" ? undefined : Number(e.target.value) })} />
                </label>
                {selPoi.category === "entrance" && (
                  <label className="col-span-2 flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={Boolean(selPoi.main)}
                      onChange={(e) =>
                        change((d) => {
                          for (const p of d.pois) p.main = p.id === selPoi.id ? e.target.checked || undefined : undefined;
                          return d;
                        })
                      }
                    />
                    Main entrance (routes start here without a location)
                  </label>
                )}
                {selPoi.survey && <p className="col-span-2 text-xs text-success">Surveyed ±{selPoi.survey.accuracy} m ({selPoi.survey.mode})</p>}
              </div>
            )}
            {selNode && (
              <label>
                Name in directions (optional)
                <input
                  className="input"
                  value={selNode.label ?? ""}
                  placeholder="the promenade"
                  onChange={(e) =>
                    change((d) => {
                      const n = d.walkways.nodes.find((x) => x.id === selNode.id);
                      if (n) n.label = e.target.value || undefined;
                      return d;
                    })
                  }
                />
              </label>
            )}
            {selBuilding && (
              <div className="grid grid-cols-2 gap-2">
                <label className="col-span-2">
                  Name
                  <input className="input" value={selBuilding.name} onChange={(e) => edit<VenueBuilding>("buildings", selBuilding.id, { name: e.target.value })} />
                </label>
                <label>
                  Kind
                  <select className="input" value={selBuilding.kind} onChange={(e) => edit<VenueBuilding>("buildings", selBuilding.id, { kind: e.target.value as VenueBuilding["kind"] })}>
                    {["building", "stand", "canopy", "wall", "area"].map((k) => (
                      <option key={k}>{k}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Height m
                  <input className="input" type="number" value={selBuilding.height} onChange={(e) => edit<VenueBuilding>("buildings", selBuilding.id, { height: Number(e.target.value) })} />
                </label>
              </div>
            )}
            {sel?.kind === "edge" && (
              <p className="text-xs text-muted">
                Walkway {sel.a} – {sel.b}. Use Delete to remove it.
              </p>
            )}
          </section>

          {/* Venue and anchor */}
          <section className="card space-y-2 text-sm">
            <h3 className="font-bold">Venue and anchor</h3>
            <label>
              Name
              <input className="input" value={doc.name} onChange={(e) => change((d) => ({ ...d, name: e.target.value }))} />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label>
                Anchor latitude
                <input className="input" type="number" step="0.000001" value={doc.geo.lat} onChange={(e) => change((d) => ({ ...d, geo: { ...d.geo, lat: Number(e.target.value) } }))} data-testid="venue-lat" />
              </label>
              <label>
                Anchor longitude
                <input className="input" type="number" step="0.000001" value={doc.geo.lng} onChange={(e) => change((d) => ({ ...d, geo: { ...d.geo, lng: Number(e.target.value) } }))} />
              </label>
              <label>
                Plan north ° (clockwise from true north)
                <input className="input" type="number" step="0.1" value={doc.geo.rotationDeg} onChange={(e) => change((d) => ({ ...d, geo: { ...d.geo, rotationDeg: Number(e.target.value) } }))} />
              </label>
              <label>
                Metres per plan unit
                <input className="input" type="number" step="0.001" value={doc.geo.scale} onChange={(e) => change((d) => ({ ...d, geo: { ...d.geo, scale: Number(e.target.value) } }))} />
              </label>
            </div>
            <p className="text-xs text-muted">The anchor is where the plan&apos;s origin is in the world. Survey mode can line the plan up from reference spots instead.</p>
            {doc.events.map((ev, i) => (
              <div key={ev.key} className="flex items-center gap-2">
                <input type="color" value={ev.color} onChange={(e) => change((d) => { d.events[i].color = e.target.value; return d; })} aria-label={`${ev.label} colour`} />
                <input className="input" value={ev.label} onChange={(e) => change((d) => { d.events[i].label = e.target.value; return d; })} />
              </div>
            ))}
            {doc.events.length < 4 && (
              <button type="button" className="btn-secondary text-xs" onClick={() => change((d) => ({ ...d, events: [...d.events, { key: `ev${d.events.length + 1}`, label: `Event ${d.events.length + 1}`, color: "#0e9aa7" }] }))}>
                Add event colour
              </button>
            )}
          </section>

          {/* Site plan */}
          <section className="card space-y-2 text-sm" data-testid="venue-underlay">
            <h3 className="font-bold">Site plan underneath</h3>
            <p className="text-xs text-muted">An aerial photo (JPEG/PNG/WebP), or the club&apos;s CAD plan as DXF (ASCII; save the DWG as DXF) or SVG. Only you see it; it is not on the public map.</p>
            <div className="flex flex-wrap gap-2">
              <label className="btn-secondary cursor-pointer text-xs">
                Upload image
                <input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => e.target.files?.[0] && uploadImage(e.target.files[0])} />
              </label>
              <label className="btn-secondary cursor-pointer text-xs">
                Import DXF / SVG
                <input type="file" accept=".dxf,.svg,image/svg+xml,application/dxf" className="hidden" onChange={(e) => e.target.files?.[0] && void importPlan(e.target.files[0])} data-testid="venue-plan-file" />
              </label>
              {underlay && (
                <button type="button" className="btn-secondary text-xs" onClick={() => { setUnderlay(null); saveUnderlay(null); }}>
                  Remove
                </button>
              )}
            </div>
            {underlay && (
              <>
                <p className="text-xs">
                  {underlay.kind === "image" ? `Image ${underlay.width} × ${underlay.height} px` : `${underlay.fileName} (${underlay.source.toUpperCase()}, ${underlay.units})`}
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <label>
                    Centre x m
                    <input className="input" type="number" value={underlay.center.x} onChange={(e) => setUnderlay({ ...underlay, center: { ...underlay.center, x: Number(e.target.value) } })} />
                  </label>
                  <label>
                    Centre y m
                    <input className="input" type="number" value={underlay.center.y} onChange={(e) => setUnderlay({ ...underlay, center: { ...underlay.center, y: Number(e.target.value) } })} />
                  </label>
                  <label>
                    Turn °
                    <input className="input" type="number" step="0.1" value={underlay.rotationDeg} onChange={(e) => setUnderlay({ ...underlay, rotationDeg: Number(e.target.value) })} />
                  </label>
                  <label>
                    {underlay.kind === "image" ? "Metres per pixel" : "Metres per unit"}
                    <input className="input" type="number" step="0.0001" value={underlay.scale} onChange={(e) => setUnderlay({ ...underlay, scale: Number(e.target.value) })} />
                  </label>
                  <label className="col-span-2">
                    Opacity
                    <input type="range" min={0.05} max={1} step={0.05} value={underlay.opacity} onChange={(e) => setUnderlay({ ...underlay, opacity: Number(e.target.value) })} className="w-full" />
                  </label>
                </div>
                {underlay.kind === "vector" && (
                  <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-border p-2" data-testid="venue-layers">
                    <div className="flex gap-2 text-xs">
                      <button type="button" className="underline" onClick={() => setUnderlay({ ...underlay, layers: underlay.layers.map((l) => ({ ...l, visible: true })) })}>
                        All
                      </button>
                      <button type="button" className="underline" onClick={() => setUnderlay({ ...underlay, layers: underlay.layers.map((l) => ({ ...l, visible: false })) })}>
                        None
                      </button>
                    </div>
                    {underlay.layers.map((l, i) => (
                      <label key={l.name} className="flex items-center gap-2 text-xs">
                        <input type="checkbox" checked={l.visible} onChange={(e) => setUnderlay({ ...underlay, layers: underlay.layers.map((x, j) => (j === i ? { ...x, visible: e.target.checked } : x)) })} />
                        <i style={{ background: l.color, width: 10, height: 10, borderRadius: 2, display: "inline-block" }} />
                        {l.name} <span className="text-muted">({l.lines.length})</span>
                      </label>
                    ))}
                  </div>
                )}
                <button type="button" className="btn-primary w-full text-xs" onClick={() => saveUnderlay(underlay)} disabled={pending}>
                  Save site plan
                </button>
              </>
            )}
            {planMsg && <p className="text-xs font-semibold" role="status">{planMsg}</p>}
          </section>

          {/* Warnings */}
          <section className="card space-y-1 text-sm" data-testid="venue-warnings">
            <h3 className="font-bold">Checks</h3>
            {[...problems, ...warnings].length === 0 ? (
              <p className="text-xs text-success">Every court and place is reached by the walkways; every court is a court of {slugs.length > 1 ? "these events" : "this event"}.</p>
            ) : (
              <ul className="list-disc space-y-1 pl-4 text-xs">
                {problems.map((p) => (
                  <li key={p} className="text-danger">
                    {p}
                  </li>
                ))}
                {warnings.map((w) => (
                  <li key={w} className="text-warning">
                    {w}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Save */}
          <section className="card space-y-2 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={published} onChange={(e) => { setPublished(e.target.checked); setDirty(true); }} data-testid="venue-published" />
              Published (on the public map and in the app)
            </label>
            <button type="button" className="btn-primary w-full" onClick={save} disabled={pending} data-testid="venue-save">
              {pending ? "Saving…" : dirty ? "Save venue" : "Save venue (no changes)"}
            </button>
            {msg && <p className={`text-xs font-semibold ${msg.ok ? "text-success" : "text-danger"}`} role="status">{msg.message}</p>}
            <p className="text-xs text-muted">Version {version}. {doc.courts.length} courts, {doc.pois.length} points, {doc.walkways.nodes.length} walkway points, {doc.buildings.length} buildings.</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-secondary text-xs" onClick={exportJson}>
                Export JSON
              </button>
              <button type="button" className="btn-secondary text-xs" onClick={() => setJson(json === null ? JSON.stringify(doc, null, 2) : null)}>
                Import JSON
              </button>
              <button type="button" className="btn-secondary text-xs" onClick={loadSample} data-testid="venue-load-sample">
                Load sample layout
              </button>
            </div>
            {json !== null && (
              <div className="space-y-2">
                <textarea className="input h-48 font-mono text-xs" value={json} onChange={(e) => setJson(e.target.value)} aria-label="Venue JSON" />
                <div className="flex gap-2">
                  <button type="button" className="btn-secondary text-xs" onClick={() => importJson(json)}>
                    Use this JSON
                  </button>
                  <label className="btn-secondary cursor-pointer text-xs">
                    From a file
                    <input type="file" accept="application/json,.json" className="hidden" onChange={async (e) => e.target.files?.[0] && importJson(await e.target.files[0].text())} />
                  </label>
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
