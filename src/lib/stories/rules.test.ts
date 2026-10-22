import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  STORY_LIFETIME_MS,
  cleanCaption,
  firstUnseen,
  groupPosters,
  isLiveStory,
  orderPosters,
  parseStoryContext,
  reportsHide,
  storyAge,
  storyExpiry,
  storyImageProblem,
  type MStory,
} from "./rules";

const ID = "11111111-2222-4333-8444-555555555555";
const story = (id: string, createdAt: string): MStory => ({ id, imageUrl: "x", kind: "match", createdAt, expiresAt: createdAt, caption: null, link: { matchId: null, tieId: null, slug: "s" } });

describe("story rules", () => {
  it("reads only known contexts", () => {
    expect(parseStoryContext({ kind: "match", matchId: ID })).toEqual({ kind: "match", matchId: ID });
    expect(parseStoryContext({ kind: "tie", tieId: ID, slug: "cairo-2026" })).toEqual({ kind: "tie", tieId: ID, slug: "cairo-2026" });
    expect(parseStoryContext({ kind: "pass", slug: "cairo-2026" })).toEqual({ kind: "pass", slug: "cairo-2026" });
    expect(parseStoryContext({ kind: "match", matchId: "x" })).toBeNull();
    expect(parseStoryContext({ kind: "gallery" })).toBeNull();
    expect(parseStoryContext(null)).toBeNull();
  });

  it("accepts only the composer's JPEG export", () => {
    expect(storyImageProblem({ type: "image/jpeg", bytes: 400_000, width: 1080, height: 1920 })).toBeNull();
    expect(storyImageProblem({ type: "image/png", bytes: 400_000, width: 1080, height: 1920 })).toBe("type");
    expect(storyImageProblem({ type: "image/jpeg", bytes: 3_000_000, width: 1080, height: 1920 })).toBe("size");
    expect(storyImageProblem({ type: "image/jpeg", bytes: 400_000, width: 1080, height: 1080 })).toBe("shape");
    expect(storyImageProblem({ type: "image/jpeg", bytes: 400_000, width: 400, height: 711 })).toBe("shape");
    expect(storyImageProblem({ type: "image/jpeg", bytes: 0, width: null, height: null })).toBe("empty");
  });

  it("lives 24 hours and hides when hidden or removed", () => {
    const now = Date.parse("2026-10-22T10:00:00Z");
    const expires = storyExpiry(now);
    expect(Date.parse(expires) - now).toBe(STORY_LIFETIME_MS);
    expect(isLiveStory({ expires_at: expires, hidden_at: null, removed_at: null }, now)).toBe(true);
    expect(isLiveStory({ expires_at: expires, hidden_at: null, removed_at: null }, now + STORY_LIFETIME_MS)).toBe(false);
    expect(isLiveStory({ expires_at: expires, hidden_at: "x", removed_at: null }, now)).toBe(false);
    expect(isLiveStory({ expires_at: expires, hidden_at: null, removed_at: "x" }, now)).toBe(false);
  });

  it("three reports hide it; after a restore only newer reports count", () => {
    const t = ["2026-10-22T10:00:00Z", "2026-10-22T10:01:00Z", "2026-10-22T10:02:00Z"];
    expect(reportsHide(t.slice(0, 2), null)).toBe(false);
    expect(reportsHide(t, null)).toBe(true);
    expect(reportsHide([...t, "2026-10-22T11:00:00Z"], "2026-10-22T10:30:00Z")).toBe(false);
  });

  it("captions are plain one-line text", () => {
    expect(cleanCaption(["<b>EGY</b> v JPN", "Junior\nFinals"])).toBe("EGY v JPN · Junior Finals");
    expect(cleanCaption([null, ""])).toBeNull();
    expect(cleanCaption(["x".repeat(300)])!.length).toBe(140);
  });

  it("groups per poster, plays oldest first, puts unseen posters first", () => {
    const rows = [
      { posterKey: "a", posterName: "Ann", posterAvatar: null, story: story("a1", "2026-10-22T09:00:00Z") },
      { posterKey: "b", posterName: "Bob", posterAvatar: null, story: story("b1", "2026-10-22T10:00:00Z") },
      { posterKey: "a", posterName: "Ann K", posterAvatar: null, story: story("a2", "2026-10-22T11:00:00Z") },
    ];
    const posters = groupPosters(rows);
    expect(posters.map((p) => p.key)).toEqual(["a", "b"]);
    expect(posters[0]!.stories.map((s) => s.id)).toEqual(["a1", "a2"]);
    expect(posters[0]!.name).toBe("Ann K");
    expect(orderPosters(posters, new Set(["a1", "a2"])).map((p) => p.key)).toEqual(["b", "a"]);
    expect(firstUnseen(posters[0]!, new Set(["a1"]))).toBe(1);
    expect(firstUnseen(posters[0]!, new Set(["a1", "a2"]))).toBe(0);
  });

  it("says how long ago", () => {
    const now = Date.parse("2026-10-22T12:00:00Z");
    expect(storyAge("2026-10-22T11:59:40Z", now)).toEqual({ unit: "now", n: 0 });
    expect(storyAge("2026-10-22T11:45:00Z", now)).toEqual({ unit: "m", n: 15 });
    expect(storyAge("2026-10-22T09:00:00Z", now)).toEqual({ unit: "h", n: 3 });
  });

  it("feeds never select private columns", () => {
    const server = readFileSync(join(__dirname, "server.ts"), "utf8");
    const columns = /const COLUMNS = "([^"]+)"/.exec(server)![1];
    // auth_user_id is read to key and filter posters, never sent: toStory and feedOf build the payload.
    for (const c of ["organization_id", "hidden_at", "hidden_reason", "removed_at", "removed_by", "restored_at"]) expect(columns).not.toContain(c);
    const toStory = server.slice(server.indexOf("function toStory"), server.indexOf("/** Live stories"));
    expect(toStory).not.toMatch(/auth_user_id|organization_id/);
  });
});
