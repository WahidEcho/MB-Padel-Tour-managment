import { describe, it, expect } from "vitest";
import { PUBLIC_PLAYER_COLUMNS, toPublicPlayer } from "./data";

const PHOTO = "https://x.supabase.co/storage/v1/object/public/media/pending/s1/a.webp";

describe("toPublicPlayer", () => {
  it("exposes a name and a face, and nothing else", () => {
    const row = {
      id: "p1",
      public_name: "Wahid",
      approval_status: "approved" as const,
      photo_url: PHOTO,
      portrait_url: null,
      focal_x: 0.3,
      focal_y: 0.2,
      // Admin-only fields that must never survive the projection.
      mobile_normalized: "+201000000000",
      email: "someone@example.com",
      notes: "admin note",
    };
    expect(Object.keys(toPublicPlayer(row)).sort()).toEqual([
      "focal_x",
      "focal_y",
      "id",
      "photo_url",
      "portrait_url",
      "public_name",
    ]);
  });

  it("withholds the photo of a player nobody has approved yet", () => {
    // Players upload their own photo at registration, so an unreviewed image
    // must not reach a public page or the venue wall.
    for (const status of ["pending", "rejected", "merged"] as const) {
      const p = toPublicPlayer({
        id: "p1",
        public_name: "Wahid",
        approval_status: status,
        photo_url: PHOTO,
        portrait_url: PHOTO,
      });
      expect(p.photo_url).toBeNull();
      expect(p.portrait_url).toBeNull();
      expect(p.public_name).toBe("Wahid");
    }
  });

  it("shows the photo once approved", () => {
    const p = toPublicPlayer({
      id: "p1",
      public_name: "Wahid",
      approval_status: "approved",
      photo_url: PHOTO,
    });
    expect(p.photo_url).toBe(PHOTO);
  });

  it("defaults the framing when a row predates the photo columns", () => {
    const p = toPublicPlayer({ id: "p1", public_name: "Wahid", approval_status: "approved" });
    expect(p).toMatchObject({ photo_url: null, focal_x: 0.5, focal_y: 0.35 });
  });

  it("selects named columns, never the mobile number", () => {
    expect(PUBLIC_PLAYER_COLUMNS).not.toContain("mobile");
    expect(PUBLIC_PLAYER_COLUMNS).not.toContain("*");
    expect(PUBLIC_PLAYER_COLUMNS).toContain("photo_url");
  });
});
