import { describe, expect, it } from "vitest";
import { STAGE, TALL_STAGE, isStageAspect, stageFor } from "./layout";

describe("stage canvas by the wall's aspect", () => {
  it("16:10 walls get 1920x1200", () => {
    expect(stageFor(1920, 1200)).toEqual(TALL_STAGE);
    expect(stageFor(2560, 1600)).toEqual(TALL_STAGE);
    // A 4 m x 2.5 m LED wall driven at its own odd resolution.
    expect(stageFor(1536, 960)).toEqual(TALL_STAGE);
    expect(stageFor(1680, 1050)).toEqual(TALL_STAGE);
  });
  it("16:9 and anything else keep 1920x1080", () => {
    expect(stageFor(1920, 1080)).toEqual(STAGE);
    expect(stageFor(3840, 2160)).toEqual(STAGE);
    expect(stageFor(1024, 768)).toEqual(STAGE); // 4:3
    expect(stageFor(2560, 1080)).toEqual(STAGE); // ultrawide
    expect(stageFor(0, 0)).toEqual(STAGE);
    expect(stageFor(Number.NaN, 1200)).toEqual(STAGE);
  });
  it("a forced aspect wins", () => {
    expect(stageFor(1920, 1080, "16:10")).toEqual(TALL_STAGE);
    expect(stageFor(1920, 1200, "16:9")).toEqual(STAGE);
    expect(isStageAspect("16:10")).toBe(true);
    expect(isStageAspect("4:3")).toBe(false);
  });
});
