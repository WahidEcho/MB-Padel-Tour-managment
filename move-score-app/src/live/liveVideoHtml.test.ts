import { describe, expect, it } from "vitest";
import { liveVideoHtml, parsePlayerMessage } from "./liveVideoHtml";

describe("in-app YouTube player page", () => {
  it("writes only a valid video id into the page", () => {
    const html = liveVideoHtml("dQw4w9WgXcQ", "https://tour.mbeg.org");
    expect(html).toContain('videoId:"dQw4w9WgXcQ"');
    expect(html).toContain("youtube-nocookie.com");
    expect(html).toContain('origin:"https://tour.mbeg.org"');
    expect(liveVideoHtml('"};alert(1);//x', "https://tour.mbeg.org")).toBeNull();
    expect(liveVideoHtml("dQw4w9WgXcQ", 'javascript:"x')).toContain('origin:"https://tour.mbeg.org"');
  });
  it("reads the player's messages, and nothing else", () => {
    expect(parsePlayerMessage('{"type":"error","code":150}')).toEqual({ type: "error", code: 150 });
    expect(parsePlayerMessage('{"type":"state","state":0}')).toEqual({ type: "state", state: 0 });
    expect(parsePlayerMessage('{"type":"ready"}')).toEqual({ type: "ready" });
    expect(parsePlayerMessage('{"type":"run","code":"x"}')).toBeNull();
    expect(parsePlayerMessage("not json")).toBeNull();
  });
});
