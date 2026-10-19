import { describe, expect, it } from "vitest";
import { activeLiveVideos, delayNote, liveVideoConfig, liveVideoForMatch, withLiveVideo, withoutLiveVideo } from "./liveVideo";
import { toPublicTournament } from "../public";
import type { BrandingConfig, Tournament } from "../types";

const ID13 = "AAAAAAAAAAA";
const ID14 = "BBBBBBBBBBB";
const branding: BrandingConfig = {
  clientLogoUrl: "https://cdn.example/logo.png",
  liveVideo: {
    overlayTitle: "  Davis Cup Juniors  ",
    courts: {
      c13: { youtubeId: ID13, on: true, delaySeconds: 8 },
      c14: { youtubeId: ID14, on: false },
      c15: { youtubeId: "not-an-id", on: true },
      c16: { youtubeId: ID13, on: true, delaySeconds: 9000 },
    },
  },
};
const courts = [
  { id: "c13", name: "Court 13 (boys)" },
  { id: "c14", name: "Court 14 (girls)" },
  { id: "c15", name: "Court 15" },
  { id: "c16", name: "Court 16", is_active: false },
];

describe("live video per court", () => {
  it("cleans what is stored: bad ids dropped, delays bounded, the title trimmed", () => {
    const cfg = liveVideoConfig(branding);
    expect(Object.keys(cfg.courts).sort()).toEqual(["c13", "c14", "c16"]);
    expect(cfg.courts.c16.delaySeconds).toBeUndefined();
    expect(cfg.overlayTitle).toBe("Davis Cup Juniors");
    expect(liveVideoConfig(null)).toEqual({ courts: {}, overlayTitle: "" });
  });

  it("only switched-on courts that are active reach viewers", () => {
    const v = activeLiveVideos(branding, courts);
    expect([...v.keys()]).toEqual(["c13"]);
    expect(v.get("c13")).toEqual({ youtubeId: ID13, court: "Court 13 (boys)", courtId: "c13", delaySeconds: 8 });
  });

  it("a match carries the video only while it is in play on that court", () => {
    const v = activeLiveVideos(branding, courts);
    expect(liveVideoForMatch({ status: "live", courtId: "c13" }, v)?.youtubeId).toBe(ID13);
    expect(liveVideoForMatch({ status: "paused", court_id: "c13" }, v)?.youtubeId).toBe(ID13);
    for (const status of ["scheduled", "ready", "completed", "walkover"]) expect(liveVideoForMatch({ status, courtId: "c13" }, v)).toBeUndefined();
    expect(liveVideoForMatch({ status: "live", courtId: "c14" }, v)).toBeUndefined();
    expect(liveVideoForMatch({ status: "live", courtId: null }, v)).toBeUndefined();
    const m = { id: "m", status: "scheduled", courtId: "c13" };
    expect(withLiveVideo(m, v)).toBe(m);
    expect("liveVideo" in withLiveVideo(m, v)).toBe(false);
    expect(withLiveVideo({ ...m, status: "live" }, v).liveVideo?.court).toBe("Court 13 (boys)");
  });

  it("public pages never get the stored settings", () => {
    expect(withoutLiveVideo(branding)).toEqual({ clientLogoUrl: "https://cdn.example/logo.png" });
    const pub = toPublicTournament({ id: "t", name: "T", slug: "t", sport: "tennis", kind: "tournament", status: "active", branding_config: branding, lower_third_text: "", public_access_enabled: true } as unknown as Tournament);
    expect(JSON.stringify(pub)).not.toContain(ID14);
    expect(pub.branding_config).not.toHaveProperty("liveVideo");
  });

  it("tells viewers how far behind the video runs", () => {
    expect(delayNote({ delaySeconds: 8 })).toBe("The video runs about 8 s behind the live score.");
    expect(delayNote(null)).toMatch(/a few seconds/);
  });
});
