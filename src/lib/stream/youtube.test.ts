import { describe, expect, it } from "vitest";
import { isYouTubeId, parseYouTubeUrl, youtubeEmbedUrl, youtubeErrorKind, youtubeWatchUrl } from "./youtube";

const ID = "dQw4w9WgXcQ";

describe("YouTube live links", () => {
  it.each([
    ID,
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}&t=42s&feature=share`,
    `https://m.youtube.com/watch?app=desktop&v=${ID}`,
    `https://www.youtube.com/live/${ID}?si=AbCdEf`,
    `youtube.com/live/${ID}`,
    `https://youtu.be/${ID}`,
    `https://youtu.be/${ID}?si=xyz`,
    `https://www.youtube.com/embed/${ID}?autoplay=1`,
    `https://www.youtube-nocookie.com/embed/${ID}`,
    `https://www.youtube.com/shorts/${ID}`,
    `http://www.youtube.com/watch?v=${ID}`,
    `  https://www.youtube.com/live/${ID}  `,
  ])("reads the video id from %s", (url) => {
    expect(parseYouTubeUrl(url)).toEqual({ ok: true, id: ID });
  });

  it("refuses a channel's live page, which names no video", () => {
    expect(parseYouTubeUrl("https://www.youtube.com/@MoveBeyondEG/live")).toEqual({ ok: false, reason: "channel_live" });
    expect(parseYouTubeUrl("https://www.youtube.com/channel/UC1234567890abcdefghij/live")).toEqual({ ok: false, reason: "channel_live" });
  });

  it("refuses other sites, look-alikes, bad ids and empty input", () => {
    expect(parseYouTubeUrl("")).toEqual({ ok: false, reason: "empty" });
    expect(parseYouTubeUrl("https://vimeo.com/123456")).toEqual({ ok: false, reason: "not_youtube" });
    expect(parseYouTubeUrl(`https://youtube.com.evil.example/watch?v=${ID}`)).toEqual({ ok: false, reason: "not_youtube" });
    expect(parseYouTubeUrl(`javascript:alert(1)//youtube.com/watch?v=${ID}`).ok).toBe(false);
    expect(parseYouTubeUrl("https://www.youtube.com/watch?v=short")).toEqual({ ok: false, reason: "no_video_id" });
    expect(parseYouTubeUrl("https://youtu.be/")).toEqual({ ok: false, reason: "no_video_id" });
    expect(parseYouTubeUrl("not a url at all")).toEqual({ ok: false, reason: "not_youtube" });
  });

  it("only an 11-character id is an id", () => {
    expect(isYouTubeId(ID)).toBe(true);
    expect(isYouTubeId(`${ID}x`)).toBe(false);
    expect(isYouTubeId("<script>ab")).toBe(false);
  });

  it("builds the player and fallback URLs from the id alone", () => {
    expect(youtubeWatchUrl(ID)).toBe(`https://www.youtube.com/watch?v=${ID}`);
    const embed = new URL(youtubeEmbedUrl(ID, { autoplay: true, origin: "https://tour.mbeg.org" }));
    expect(embed.host).toBe("www.youtube-nocookie.com");
    expect(embed.pathname).toBe(`/embed/${ID}`);
    expect(embed.searchParams.get("playsinline")).toBe("1");
    expect(embed.searchParams.get("autoplay")).toBe("1");
    expect(embed.searchParams.get("enablejsapi")).toBe("1");
    expect(embed.searchParams.get("origin")).toBe("https://tour.mbeg.org");
  });

  it("tells embedding switched off from a missing video", () => {
    expect(youtubeErrorKind(150)).toBe("embedding_disabled");
    expect(youtubeErrorKind(101)).toBe("embedding_disabled");
    expect(youtubeErrorKind(153)).toBe("embedding_disabled");
    expect(youtubeErrorKind(100)).toBe("unavailable");
    expect(youtubeErrorKind(5)).toBe("error");
  });
});
