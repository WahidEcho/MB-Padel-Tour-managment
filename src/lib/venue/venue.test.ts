import { describe, expect, it } from "vitest";
import { buildGraph, shortestPath, snapToGraph, reachableFrom, polylineLength } from "./graph";
import { closestOnSegment, courtPolygon, geoToLocal, haversine, headingToPlanAngle, localToGeo, segmentEntersPolygon } from "./geo";
import { directionsFor, formatDistance, formatDuration, legsOf, turnAngle, turnOf } from "./directions";
import { mainEntrance, normalizeCourtName, planRoute, routeStart, targetOf } from "./route";
import { NAV_START, navStep, progressOn, offRouteThreshold } from "./navigate";
import { parseVenue, venueWarnings } from "./validate";
import { sampleVenue, SAMPLE_NOTE } from "./sample";
import { PUBLIC_VENUE_KEYS, courtForRow, keysOf, linkCourts, toPublicVenue } from "./public";
import { courtLive, scoreLine, venueLive, type EventFeed } from "./live";
import { averageFixes, fitGeo } from "./fit";
import { parseFromMap, parseToMap, embeddedMapUrl } from "./bridge";
import { parseDxf } from "./dxf";
import { buildScene, ribbon, triangulate } from "./scene";
import { fitCamera, interpolate, project, screenToGround, viewProjection, type Camera } from "./camera";
import type { MMatch, MTie } from "../mobile/contract";
import type { VenueDoc } from "./types";

const GEO = { lat: 30.1008, lng: 31.3708, rotationDeg: 0, scale: 1 };

describe("geo ↔ plan", () => {
  it("round-trips at every rotation and scale", () => {
    for (const rotationDeg of [0, 33, 90, 180, 271.5]) {
      for (const scale of [1, 0.001, 2.5]) {
        const geo = { ...GEO, rotationDeg, scale };
        for (const p of [{ x: 0, y: 0 }, { x: 120, y: -40 }, { x: -300, y: 250 }]) {
          const g = localToGeo(geo, p);
          const back = geoToLocal(geo, g.lat, g.lng);
          expect(back.x).toBeCloseTo(p.x, 4);
          expect(back.y).toBeCloseTo(p.y, 4);
        }
      }
    }
  });

  it("puts plan metres the right distance and direction from the anchor", () => {
    const north = localToGeo(GEO, { x: 0, y: 100 });
    expect(haversine(GEO, north)).toBeCloseTo(100, 0);
    expect(north.lat).toBeGreaterThan(GEO.lat);
    const east = localToGeo(GEO, { x: 100, y: 0 });
    expect(haversine(GEO, east)).toBeCloseTo(100, 0);
    expect(east.lng).toBeGreaterThan(GEO.lng);
    // Rotated 90°: the plan's +y points east.
    const r = localToGeo({ ...GEO, rotationDeg: 90 }, { x: 0, y: 50 });
    expect(r.lng).toBeGreaterThan(GEO.lng);
    expect(r.lat).toBeCloseTo(GEO.lat, 6);
  });

  it("turns a compass heading into a plan angle", () => {
    expect(headingToPlanAngle(GEO, 0)).toBeCloseTo(Math.PI / 2); // north = plan +y
    expect(headingToPlanAngle(GEO, 90)).toBeCloseTo(0); // east = plan +x
    expect(headingToPlanAngle({ ...GEO, rotationDeg: 90 }, 90)).toBeCloseTo(Math.PI / 2); // east = plan +y when the plan is turned
  });

  it("finds the closest point on a segment and walls through polygons", () => {
    const c = closestOnSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 });
    expect(c.point).toEqual({ x: 5, y: 0 });
    expect(c.distance).toBe(3);
    const court = courtPolygon({ center: { x: 0, y: 0 }, width: 18, length: 36, angleDeg: 0 });
    expect(segmentEntersPolygon({ x: -20, y: 0 }, { x: 20, y: 0 }, court)).toBe(true);
    expect(segmentEntersPolygon({ x: -20, y: 20 }, { x: 20, y: 20 }, court)).toBe(false);
    expect(segmentEntersPolygon({ x: -5, y: 0 }, { x: 5, y: 0 }, court)).toBe(true);
  });
});

/** A small square block: a path round a court, and a shortcut straight across it. */
function blockDoc(): Pick<VenueDoc, "walkways" | "courts" | "buildings"> {
  return {
    courts: [{ id: "c1", number: 1, name: "Court 1", event: null, center: { x: 50, y: 50 }, width: 18, length: 36, angleDeg: 0 }],
    buildings: [],
    walkways: {
      nodes: [
        { id: "sw", x: 0, y: 0 },
        { id: "se", x: 100, y: 0 },
        { id: "ne", x: 100, y: 100 },
        { id: "nw", x: 0, y: 100 },
        { id: "w", x: 0, y: 50 },
        { id: "e", x: 100, y: 50 },
      ],
      edges: [
        { a: "sw", b: "se" },
        { a: "se", b: "e" },
        { a: "e", b: "ne" },
        { a: "ne", b: "nw" },
        { a: "nw", b: "w" },
        { a: "w", b: "sw" },
        { a: "w", b: "e" }, // straight through Court 1: must be dropped
      ],
    },
  };
}

describe("walkway graph", () => {
  it("drops an edge through a court and lists it", () => {
    const g = buildGraph(blockDoc());
    expect(g.edges).toHaveLength(6);
    expect(g.blocked).toEqual([{ a: "w", b: "e", through: "Court 1" }]);
  });

  it("snaps a point to the nearest edge", () => {
    const g = buildGraph(blockDoc());
    const s = snapToGraph(g, { x: 30, y: 4 })!;
    expect(s.point.x).toBeCloseTo(30);
    expect(s.point.y).toBeCloseTo(0);
    expect(s.distance).toBeCloseTo(4);
  });

  it("finds the shortest walk round the court, never across it", () => {
    const g = buildGraph(blockDoc());
    const from = snapToGraph(g, { x: 0, y: 50 })!;
    const to = snapToGraph(g, { x: 100, y: 50 })!;
    const p = shortestPath(g, from, to)!;
    expect(p.length).toBeCloseTo(200, 3);
    expect(polylineLength(p.points)).toBeCloseTo(200, 3);
    // Every point is on the square's sides, none inside.
    for (const pt of p.points) expect(pt.x === 0 || pt.x === 100 || pt.y === 0 || pt.y === 100).toBe(true);
  });

  it("walks straight along one edge", () => {
    const g = buildGraph(blockDoc());
    const p = shortestPath(g, snapToGraph(g, { x: 10, y: 0 })!, snapToGraph(g, { x: 60, y: 0 })!)!;
    expect(p.length).toBeCloseTo(50);
    expect(p.points).toHaveLength(2);
  });

  it("says when two places do not connect", () => {
    const doc = blockDoc();
    doc.walkways.nodes.push({ id: "x1", x: 300, y: 0 }, { id: "x2", x: 300, y: 50 });
    doc.walkways.edges.push({ a: "x1", b: "x2" });
    const g = buildGraph(doc);
    expect(shortestPath(g, snapToGraph(g, { x: 0, y: 10 })!, snapToGraph(g, { x: 300, y: 10 })!)).toBeNull();
    expect(reachableFrom(g, "sw").has("x1")).toBe(false);
  });
});

describe("directions", () => {
  it("rounds distances and times as people say them", () => {
    expect(formatDistance(3.4)).toBe("3 m");
    expect(formatDistance(42)).toBe("40 m");
    expect(formatDistance(43)).toBe("45 m");
    expect(formatDistance(234)).toBe("230 m");
    expect(formatDistance(1530)).toBe("1.5 km");
    expect(formatDuration(30)).toBe("under a minute");
    expect(formatDuration(150)).toBe("3 min");
  });

  it("names turns by their angle (positive is left)", () => {
    expect(turnAngle({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 })).toBeCloseTo(90);
    expect(turnOf(90)).toBe("left");
    expect(turnOf(-90)).toBe("right");
    expect(turnOf(40)).toBe("slight_left");
    expect(turnOf(10)).toBeNull();
    expect(turnOf(170)).toBe("u_turn");
  });

  it("merges straight runs and short kinks into legs", () => {
    const legs = legsOf([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 40, y: 1 }, { x: 40, y: 2 }, { x: 40, y: 30 }]);
    expect(legs).toHaveLength(2);
    expect(legs[0].length).toBeCloseTo(40, 0);
  });

  it("writes Walk 40 m, then turn left towards Court 7", () => {
    const pts = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 25 }];
    const steps = directionsFor(pts, { name: "Court 7", point: { x: 30, y: 25 } });
    expect(steps.map((s) => s.text)).toEqual(["Walk 40 m, then turn left towards Court 7", "Walk 25 m to Court 7 on your left", "You've arrived at Court 7."]);
    expect(steps[0].turn).toBe("left");
  });

  it("names a landmark near a turn that is not the last", () => {
    const pts = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: -30 }, { x: 80, y: -30 }];
    const steps = directionsFor(pts, { name: "Medical", point: { x: 80, y: -30 } }, [{ name: "the clubhouse terrace", point: { x: 42, y: -32 } }]);
    expect(steps[0].text).toBe("Walk 40 m, then turn right towards the clubhouse terrace");
    expect(steps[1].text).toBe("Walk 30 m, then turn left towards Medical");
    expect(steps.at(-1)!.kind).toBe("arrive");
  });
});

describe("the sample venue", () => {
  const doc = sampleVenue();

  it("is a valid document that says it is a sample", () => {
    const parsed = parseVenue(JSON.parse(JSON.stringify(doc)));
    expect(parsed.problems).toEqual([]);
    expect(parsed.ok).toBe(true);
    expect(parsed.doc).toEqual(doc);
    expect(doc.sample).toBe(true);
    expect(doc.note).toBe(SAMPLE_NOTE);
  });

  it("has 16 numbered courts, two events, two streamed courts and every category", () => {
    expect(doc.courts.map((c) => c.number)).toEqual([...Array(16).keys()].map((i) => i + 1));
    expect(doc.courts.filter((c) => c.event === "dc")).toHaveLength(8);
    expect(doc.courts.filter((c) => c.event === "bjk")).toHaveLength(8);
    expect(doc.courts.filter((c) => c.streamed).map((c) => c.name)).toEqual(["Court 1", "Court 9"]);
    for (const cat of ["toilets", "food", "medical", "entrance", "parking", "referee", "desk", "lounge", "prayer"]) {
      expect(doc.pois.some((p) => p.category === cat), cat).toBe(true);
    }
    expect(mainEntrance(doc)?.name).toBe("Main Entrance");
  });

  it("has no walkway through a court or a building, and reaches every place", () => {
    expect(buildGraph(doc).blocked).toEqual([]);
    expect(venueWarnings(doc)).toEqual([]);
  });

  it("routes from the main entrance to every court and point of interest", () => {
    const start = routeStart(doc, null)!;
    expect(start.fromEntrance).toBe(true);
    expect(start.note).toBe("Your location isn't available, so the route starts at the Main Entrance.");
    for (const key of [...doc.courts.map((c) => `court:${c.id}`), ...doc.pois.map((p) => `poi:${p.id}`)]) {
      const target = targetOf(doc, key)!;
      const r = planRoute(doc, start, target);
      expect(r, key).not.toBeNull();
      expect(r!.steps.at(-1)!.text).toBe(`You've arrived at ${target.name}.`);
    }
  });

  it("walks to Court 7 round the courts, with distance, time and steps", () => {
    const start = routeStart(doc, null)!;
    const r = planRoute(doc, start, targetOf(doc, "court:7")!)!;
    expect(r.target.name).toBe("Court 7");
    expect(r.length).toBeGreaterThan(150);
    expect(r.length).toBeLessThan(260);
    expect(r.seconds).toBe(Math.round(r.length / 1.2));
    const courtPolys = doc.courts.map((c) => courtPolygon(c));
    for (let i = 1; i < r.points.length; i++) {
      for (const poly of courtPolys) expect(segmentEntersPolygon(r.points[i - 1], r.points[i], poly)).toBe(false);
    }
    expect(r.steps.some((s) => /turn (left|right)/.test(s.text))).toBe(true);
    expect(r.steps.at(-2)!.text).toMatch(/to Court 7/);
  });

  it("starts at the phone when it is at the venue, at the entrance otherwise", () => {
    const here = localToGeo(doc.geo, { x: 150, y: 74 });
    expect(routeStart(doc, { ...here, accuracy: 8 })!.fromEntrance).toBe(false);
    const vague = routeStart(doc, { ...here, accuracy: 300 })!;
    expect(vague.fromEntrance).toBe(true);
    expect(vague.reason).toBe("inaccurate");
    const far = routeStart(doc, { lat: 30.05, lng: 31.23, accuracy: 5 })!;
    expect(far.reason).toBe("far_away");
    expect(far.note).toMatch(/not at the venue yet/);
  });

  it("finds courts by id, number and name", () => {
    expect(targetOf(doc, "court:c7")?.name).toBe("Court 7");
    expect(targetOf(doc, "court:7")?.name).toBe("Court 7");
    expect(targetOf(doc, "court:Court 07")?.name).toBe("Court 7");
    expect(targetOf(doc, "poi:medical")?.name).toBe("Medical");
    expect(targetOf(doc, "poi:nope")).toBeNull();
    expect(normalizeCourtName(" COURT  12 ")).toBe("12");
  });
});

describe("live navigation", () => {
  const doc = sampleVenue();
  const route = planRoute(doc, routeStart(doc, null)!, targetOf(doc, "court:c7")!)!;

  it("follows progress along the route and the next step", () => {
    const mid = route.points[2];
    const p = progressOn(route.points, route.steps, { x: mid.x + 1, y: mid.y });
    expect(p.offset).toBeLessThan(2);
    expect(p.remaining).toBeLessThan(route.length);
    expect(p.stepIndex).toBeGreaterThanOrEqual(0);
  });

  it("re-routes after two fixes off the route, not one", () => {
    const off = { x: route.points[1].x + 60, y: route.points[1].y + 60 };
    const one = navStep(NAV_START, route, off, 8);
    expect(one.event).toBe("progress");
    const two = navStep(one.state, route, off, 8);
    expect(two.event).toBe("reroute");
    // A good fix in between resets the count.
    const back = navStep(one.state, route, route.points[1], 8);
    expect(navStep(back.state, route, off, 8).event).toBe("progress");
  });

  it("is generous with a vague fix", () => {
    expect(offRouteThreshold(40)).toBeGreaterThan(offRouteThreshold(5));
  });

  it("says arrived at the end", () => {
    const end = route.points.at(-1)!;
    const r = navStep(NAV_START, route, { x: end.x + 2, y: end.y }, 6);
    expect(r.event).toBe("arrived");
    expect(navStep(r.state, route, { x: 0, y: 0 }, 6).event).toBe("arrived");
  });

  it("re-plans from where the walker is (snapped to the walkways)", () => {
    const here = { x: 176, y: 60 };
    const again = planRoute(doc, { point: here, fromEntrance: false, reason: "location", note: null }, route.target)!;
    expect(again.length).toBeLessThan(route.length);
  });
});

describe("reading a venue document", () => {
  it("drops unknown fields and refuses bad ones", () => {
    const doc = sampleVenue() as unknown as Record<string, unknown>;
    const parsed = parseVenue({ ...doc, secret: "x", courts: [{ ...(doc.courts as object[])[0], evil: "<script>" }] });
    expect(JSON.stringify(parsed.doc)).not.toMatch(/secret|evil|script/);
    expect(parseVenue({ geo: { lat: 200, lng: 0 } }).ok).toBe(false);
    expect(parseVenue("nope").ok).toBe(false);
    const dup = parseVenue({ ...doc, pois: [...(doc.pois as object[]), (doc.pois as object[])[0]] });
    expect(dup.problems.join(" ")).toMatch(/used twice/);
    const badEdge = parseVenue({ ...doc, walkways: { nodes: [], edges: [{ a: "x", b: "y" }] } });
    expect(badEdge.problems.join(" ")).toMatch(/not a node/);
  });

  it("warns about courts that link to no court row and rows not on the map", () => {
    const doc = sampleVenue();
    const w = venueWarnings(doc, [
      ...doc.courts.slice(0, 15).map((c) => ({ slug: "boys", court_name: c.name })),
      { slug: "girls", court_name: "Court 17" },
    ]);
    expect(w).toContain("Court 16 on the map is not a court of these events (its live match cannot be shown).");
    expect(w).toContain("Court 17 (girls) is not on the map.");
  });
});

describe("public projection and linking", () => {
  const doc = sampleVenue();
  doc.courts[0].survey = { lat: 30.1, lng: 31.3, accuracy: 3, samples: 9, at: "2026-10-20T10:00:00.000Z", mode: "move" };
  doc.pois[0].survey = { lat: 30.1, lng: 31.3, accuracy: 3, samples: 9, at: "2026-10-20T10:00:00.000Z", mode: "align" };
  const rows = [
    { slug: "boys", id: "11111111-1111-4111-8111-111111111111", court_name: "Court 1" },
    { slug: "girls", id: "22222222-2222-4222-8222-222222222222", court_name: "court 1" },
    { slug: "girls", id: "33333333-3333-4333-8333-333333333333", court_name: "Court 9" },
  ];

  it("links each map court to the rows of both events by name", () => {
    const linked = linkCourts(doc, rows);
    expect(linked[0].links).toEqual([
      { slug: "boys", courtId: rows[0].id },
      { slug: "girls", courtId: rows[1].id },
    ]);
    expect(linked[8].links).toEqual([{ slug: "girls", courtId: rows[2].id }]);
    expect(linked[3].links).toEqual([]);
  });

  it("carries only public keys and never a survey fix", () => {
    const pub = toPublicVenue({ id: "v", version: 3 }, doc, rows, ["boys", "girls"]);
    const keys = keysOf(pub);
    for (const k of keys) expect(PUBLIC_VENUE_KEYS as readonly string[]).toContain(k);
    expect(JSON.stringify(pub)).not.toMatch(/survey|accuracy|samples/);
    expect(courtForRow(pub, rows[2].id)?.name).toBe("Court 9");
  });
});

describe("courts' live lines", () => {
  const T = (id: string, extra: Partial<MTie> = {}): MTie => ({ id, stage: "group", groupId: null, roundNo: 1, roundName: null, order: 1, courtId: "k7", scheduledTime: "2026-11-03T08:00:00Z", a: "egy", b: "usa", status: "live", rubbersA: 1, rubbersB: 0, winner: null, placesFrom: null, placesTo: null, lineupLocked: true, ...extra });
  const M = (id: string, extra: Partial<MMatch> = {}): MMatch => ({ id, tieId: null, rubberNo: null, rubberType: null, stage: "group", groupId: null, round: null, order: 1, courtId: "k7", scheduledTime: null, status: "live", a: "egy", b: "usa", aPlayers: [], bPlayers: [], winner: null, startedAt: null, endedAt: null, score: null, ...extra });
  const score = { sets: [{ a: 6, b: 4 }], games: { a: 3, b: 2 }, points: { a: "15", b: "30" }, tiebreak: false, serving: "A" as const, setsWon: { a: 1, b: 0 }, lastEventNumber: 40, lastUndo: 0, updatedAt: null };
  const team = (id: string, code: string) => ({ id, name: code, code, iso2: null, seed: null, groupId: null, status: "active" as const, players: [] });
  const feed = (ties: MTie[], matches: MMatch[]): EventFeed => ({
    slug: "boys",
    bundle: { teams: [team("egy", "EGY"), team("usa", "USA")], courts: [{ id: "k7", name: "Court 7", order: 7 }] },
    live: { ties, matches },
  });

  it("shows a live tie with its rubber score", () => {
    const l = courtLive({ id: "c7", name: "Court 7" }, [feed([T("t1")], [M("m1", { tieId: "t1", score })])])!;
    expect(l).toMatchObject({ live: true, title: "EGY 1–0 USA", detail: "6–4 3–2", matchId: "m1", tieId: "t1", slug: "boys" });
  });

  it("shows a live match, or the next one", () => {
    expect(courtLive({ id: "c7", name: "court 7" }, [feed([], [M("m1", { score })])])).toMatchObject({ live: true, title: "EGY v USA", detail: "6–4 3–2" });
    const next = courtLive({ id: "c7", name: "Court 7" }, [feed([T("t1", { status: "scheduled" })], [])])!;
    expect(next.live).toBe(false);
    expect(next.detail).toBe("Next · 10:00");
    expect(courtLive({ id: "c8", name: "Court 8" }, [feed([T("t1")], [])])).toBeNull();
    expect(venueLive([{ id: "c7", name: "Court 7" }, { id: "c8", name: "Court 8" }], [feed([T("t1")], [])])).toHaveLength(1);
  });

  it("writes a score line", () => {
    expect(scoreLine(null)).toBeNull();
    expect(scoreLine({ ...score, sets: [], games: { a: 0, b: 0 } })).toBe("0–0");
  });
});

describe("survey and alignment", () => {
  it("averages fixes weighted by accuracy", () => {
    const a = averageFixes([
      { lat: 30.0, lng: 31.0, accuracy: 4 },
      { lat: 30.00002, lng: 31.00002, accuracy: 4 },
      { lat: 31, lng: 32, accuracy: 900 },
    ])!;
    expect(a.samples).toBe(2);
    expect(a.lat).toBeCloseTo(30.00001, 6);
    expect(a.accuracy).toBeGreaterThanOrEqual(2.4);
    expect(averageFixes([])).toBeNull();
  });

  it("fits the anchor and rotation from surveyed spots", () => {
    const truth = { lat: 30.1, lng: 31.37, rotationDeg: 25, scale: 1 };
    const plan = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 100, y: 150 }];
    const pairs = plan.map((p) => ({ plan: p, ...localToGeo(truth, p), accuracy: 3 }));
    const guess = { lat: 30.1005, lng: 31.3712, rotationDeg: 0, scale: 1 };
    const fit = fitGeo(guess, pairs)!;
    expect(fit.rms).toBeLessThan(0.05);
    expect(fit.geo.rotationDeg).toBeCloseTo(25, 2);
    expect(haversine(fit.geo, truth)).toBeLessThan(0.05);
    // One spot: the anchor moves, the rotation stays.
    const one = fitGeo(guess, pairs.slice(0, 1))!;
    expect(one.geo.rotationDeg).toBe(0);
    expect(haversine(one.geo, truth)).toBeLessThan(0.05);
    // Scale only from three spots, when asked.
    const scaled = fitGeo(guess, plan.map((p) => ({ plan: { x: p.x / 2, y: p.y / 2 }, ...localToGeo(truth, p) })), { fitScale: true })!;
    expect(scaled.geo.scale).toBeCloseTo(2, 3);
  });
});

describe("the app bridge", () => {
  it("parses only well-formed messages", () => {
    expect(parseToMap(JSON.stringify({ type: "location", lat: 30.1, lng: 31.3, accuracy: 6, heading: 370 }))).toMatchObject({ type: "location", heading: 10 });
    expect(parseToMap({ type: "location", lat: "30", lng: 31 })).toBeNull();
    expect(parseToMap({ type: "focus", target: "court:c7" })).toEqual({ type: "focus", target: "court:c7" });
    expect(parseToMap({ type: "focus", target: "javascript:alert(1)" })).toBeNull();
    expect(parseToMap("{")).toBeNull();
    const id = "11111111-1111-4111-8111-111111111111";
    expect(parseFromMap({ type: "open-match", slug: "boys", matchId: id })).toEqual({ type: "open-match", slug: "boys", matchId: id });
    expect(parseFromMap({ type: "open-match", slug: "../x", matchId: id })).toBeNull();
    expect(parseFromMap({ type: "open-court", name: "Court 7", slug: "boys", courtId: "nope" })).toEqual({ type: "open-court", name: "Court 7", slug: "boys", courtId: null });
    expect(parseFromMap({ type: "want-location", on: true })).toEqual({ type: "want-location", on: true });
    expect(embeddedMapUrl("https://tour.mbeg.org/", "boys", { scheme: "dark", focus: "court:c7" })).toBe("https://tour.mbeg.org/t/boys/map?embed=app&theme=dark&focus=court%3Ac7");
  });
});

describe("DXF site plans", () => {
  const dxf = (body: string, units = 6) =>
    ["0", "SECTION", "2", "HEADER", "9", "$INSUNITS", "70", String(units), "0", "ENDSEC",
      "0", "SECTION", "2", "TABLES", "0", "TABLE", "2", "LAYER", "0", "LAYER", "2", "COURTS", "62", "3", "0", "ENDTAB", "0", "ENDSEC",
      "0", "SECTION", "2", "BLOCKS", "0", "BLOCK", "2", "POST", "10", "0", "20", "0", "0", "LINE", "8", "0", "10", "0", "20", "0", "11", "1", "21", "0", "0", "ENDBLK", "0", "ENDSEC",
      "0", "SECTION", "2", "ENTITIES", body, "0", "ENDSEC", "0", "EOF"].join("\n");

  it("reads lines, polylines, circles and block inserts by layer, with units", () => {
    const body = [
      "0", "LINE", "8", "COURTS", "10", "0", "20", "0", "11", "10", "21", "0",
      "0", "LWPOLYLINE", "8", "BUILDINGS", "90", "4", "70", "1", "10", "0", "20", "0", "10", "5", "20", "0", "10", "5", "20", "5", "10", "0", "20", "5",
      "0", "CIRCLE", "8", "TREES", "10", "50", "20", "50", "40", "2",
      "0", "INSERT", "8", "FENCE", "2", "POST", "10", "100", "20", "100", "50", "90",
      "0", "TEXT", "8", "LABELS", "1", "Court 1",
    ].join("\n");
    const plan = parseDxf(dxf(body, 4));
    expect(plan.units).toBe("millimetres");
    expect(plan.metresPerUnit).toBe(0.001);
    expect(plan.layers.map((l) => l.name)).toEqual(["BUILDINGS", "COURTS", "FENCE", "TREES"]);
    expect(plan.layers.find((l) => l.name === "COURTS")!.color).toBe("#12a150");
    expect(plan.layers.find((l) => l.name === "BUILDINGS")!.lines[0]).toHaveLength(10); // closed: 4 corners + back to the first
    const post = plan.layers.find((l) => l.name === "FENCE")!.lines[0];
    expect(post[0]).toBeCloseTo(100);
    expect(post[2]).toBeCloseTo(100);
    expect(post[3]).toBeCloseTo(101); // the block rotated 90°
    expect(plan.skipped.TEXT).toBe(1);
    expect(plan.bounds.maxY).toBeCloseTo(101);
  });

  it("turns a bulge into an arc", () => {
    const body = ["0", "LWPOLYLINE", "8", "A", "90", "2", "70", "0", "10", "0", "20", "0", "42", "1", "10", "10", "20", "0"].join("\n");
    const pts = parseDxf(dxf(body)).layers[0].lines[0];
    // A semicircle (bulge 1) of radius 5 about (5, 0): its middle point is 5 below the chord.
    const ys = pts.filter((_, i) => i % 2 === 1);
    expect(Math.min(...ys)).toBeCloseTo(-5, 1);
  });

  it("refuses what it cannot read", () => {
    expect(() => parseDxf("AutoCAD Binary DXF\r\n")).toThrow(/binary/);
    expect(() => parseDxf("hello")).toThrow(/ENTITIES/);
  });
});

describe("scene and camera", () => {
  it("triangulates concave polygons", () => {
    const L = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 10 }, { x: 0, y: 10 }];
    expect(triangulate(L)).toHaveLength(12);
    expect(triangulate([...L].reverse())).toHaveLength(12);
  });

  it("builds the sample scene in both themes", async () => {
    const { VENUE_THEMES } = await import("./scene");
    for (const t of [VENUE_THEMES.light, VENUE_THEMES.dark]) {
      const s = buildScene(sampleVenue(), t);
      expect(s.count).toBeGreaterThan(1000);
      expect(s.count % 3).toBe(0);
      expect(s.position.every(Number.isFinite)).toBe(true);
    }
    expect(ribbon([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], 2, 0.1).count).toBeGreaterThan(12);
  });

  it("projects the target to the screen centre and back to the ground", () => {
    const cam: Camera = { tx: 100, ty: 50, distance: 200, yaw: 0.4, pitch: 0.9, fovY: 0.8 };
    const { viewProj, inv } = viewProjection(cam, 1.5);
    const p = project(viewProj, 100, 50, 0, 900, 600)!;
    expect(p.sx).toBeCloseTo(450, 3);
    expect(p.sy).toBeCloseTo(300, 3);
    const g = screenToGround(inv!, 700, 420, 900, 600)!;
    const again = project(viewProj, g.x, g.y, 0, 900, 600)!;
    expect(again.sx).toBeCloseTo(700, 2);
    expect(again.sy).toBeCloseTo(420, 2);
    // Plan north is up the screen at yaw 0.
    const flat = viewProjection({ ...cam, yaw: 0 }, 1.5).viewProj;
    expect(project(flat, 100, 80, 0, 900, 600)!.sy).toBeLessThan(300);
    expect(project(flat, 130, 50, 0, 900, 600)!.sx).toBeGreaterThan(450);
  });

  it("fits a box and flies smoothly", () => {
    const c = fitCamera({ minX: 0, minY: 0, maxX: 280, maxY: 200 }, 0.5, { yaw: 0, pitch: 1, fovY: 0.8 });
    expect(c.tx).toBe(140);
    const mid = interpolate(c, { ...c, tx: 200, yaw: c.yaw + 6 }, 0.5);
    expect(mid.tx).toBeCloseTo(170);
    expect(interpolate(c, { ...c, tx: 200 }, 1).tx).toBe(200);
  });
});

describe("survey mode", () => {
  it("moves a feature to the surveyed spot and keeps the fix", async () => {
    const { applySurvey } = await import("./survey");
    const doc = sampleVenue();
    const spot = localToGeo(doc.geo, { x: 33, y: -28 });
    const r = applySurvey(doc, "poi:main-gate", { ...spot, accuracy: 3.2, samples: 12 }, "move");
    if ("error" in r) throw new Error(r.error);
    const gate = r.doc.pois.find((p) => p.id === "main-gate")!;
    expect(gate.point.x).toBeCloseTo(33, 1);
    expect(gate.point.y).toBeCloseTo(-28, 1);
    expect(gate.survey).toMatchObject({ accuracy: 3.2, samples: 12, mode: "move" });
    expect(doc.pois.find((p) => p.id === "main-gate")!.point.x).toBe(40); // the input is untouched
    expect(r.message).toMatch(/Main Entrance placed/);
    expect("error" in applySurvey(doc, "poi:nope", { ...spot, accuracy: 3, samples: 1 }, "move")).toBe(true);
  });

  it("lines the plan up from reference spots", async () => {
    const { applySurvey } = await import("./survey");
    const truth = { lat: 30.0961, lng: 31.3762, rotationDeg: 12, scale: 1 };
    let doc = sampleVenue();
    for (const ref of ["poi:main-gate", "court:c16", "poi:prayer"]) {
      const f = ref.startsWith("court") ? doc.courts.find((c) => `court:${c.id}` === ref)!.center : doc.pois.find((p) => `poi:${p.id}` === ref)!.point;
      const r = applySurvey(doc, ref, { ...localToGeo(truth, f), accuracy: 2, samples: 10 }, "align");
      if ("error" in r) throw new Error(r.error);
      doc = r.doc;
    }
    expect(doc.geo.rotationDeg).toBeCloseTo(12, 2);
    expect(haversine(doc.geo, truth)).toBeLessThan(0.05);
    expect(doc.pois.find((p) => p.id === "main-gate")!.point).toEqual({ x: 40, y: -30 });
  });
});
