import { describe, expect, it } from "vitest";
import {
  NO_COURT_TITLE,
  NO_TIME_TITLE,
  TBC_DAY,
  dayKeyIn,
  defaultScheduleDay,
  itemDay,
  scheduleDayLabel,
  scheduleDays,
  scheduleForDay,
  type ScheduleItem,
} from "./orderOfPlay";

const TZ = "Africa/Cairo"; // UTC+2 in November 2026
const courts = [
  { id: "c1", name: "Centre Court", order: 1 },
  { id: "c2", name: "Court 2", order: 2 },
];
const item = (id: string, over: Partial<ScheduleItem> = {}): ScheduleItem => ({
  id,
  courtId: "c1",
  scheduledTime: null,
  order: 0,
  status: "scheduled",
  ...over,
});

describe("days in the event's zone", () => {
  it("files a late-evening UTC time under the next Cairo day", () => {
    expect(dayKeyIn("2026-11-02T22:30:00Z", TZ)).toBe("2026-11-03");
    expect(dayKeyIn("2026-11-02T21:59:00+00:00", TZ)).toBe("2026-11-02");
  });

  it("uses when it was played when there is no time, else the to-be-scheduled bucket", () => {
    expect(itemDay({ scheduledTime: null, startedAt: "2026-11-04T08:00:00Z" }, TZ)).toBe("2026-11-04");
    expect(itemDay({ scheduledTime: null }, TZ)).toBe(TBC_DAY);
  });

  it("lists every day with play in order, the bucket last", () => {
    const days = scheduleDays(
      [item("a", { scheduledTime: "2026-11-04T08:00:00Z" }), item("b"), item("c", { scheduledTime: "2026-11-02T08:00:00Z" }), item("d", { scheduledTime: "2026-11-04T12:00:00Z" })],
      TZ,
    );
    expect(days).toEqual(["2026-11-02", "2026-11-04", TBC_DAY]);
  });

  it("labels a day without the phone's zone shifting it", () => {
    expect(scheduleDayLabel("2026-11-02")).toBe("Mon 2 Nov");
    expect(scheduleDayLabel(TBC_DAY)).toBe("To be scheduled");
  });
});

describe("the day the picker opens on", () => {
  const days = ["2026-11-02", "2026-11-03", "2026-11-05", TBC_DAY];
  it("is today when today has play", () => expect(defaultScheduleDay(days, "2026-11-03")).toBe("2026-11-03"));
  it("is the next day with play on a rest day", () => expect(defaultScheduleDay(days, "2026-11-04")).toBe("2026-11-05"));
  it("is the first day before the event", () => expect(defaultScheduleDay(days, "2026-10-20")).toBe("2026-11-02"));
  it("is the last day after the event", () => expect(defaultScheduleDay(days, "2026-12-01")).toBe("2026-11-05"));
  it("is the bucket only when nothing has a day", () => expect(defaultScheduleDay([TBC_DAY], "2026-11-02")).toBe(TBC_DAY));
  it("is nothing without play", () => expect(defaultScheduleDay([], "2026-11-02")).toBeNull());
});

describe("a day by court", () => {
  const list = [
    item("t3", { courtId: "c2", order: 3, scheduledTime: "2026-11-02T08:00:00Z" }),
    item("t1", { courtId: "c1", order: 1, scheduledTime: "2026-11-02T08:00:00Z", status: "done" }),
    // Followed by (no time; its day is the day it started): after t1 on its court, before 14:00.
    item("t2", { courtId: "c1", order: 2, status: "live", startedAt: "2026-11-02T10:05:00Z" }),
    item("t5", { courtId: "c1", order: 5, scheduledTime: "2026-11-02T12:00:00Z" }),
    item("t4", { courtId: null, order: 4, scheduledTime: "2026-11-02T13:00:00Z" }),
    item("x", { courtId: "c1", order: 0, scheduledTime: "2026-11-03T08:00:00Z" }),
  ];

  it("groups in court order, unknown courts last, each court in playing order", () => {
    const s = scheduleForDay(list, { day: "2026-11-02", timeZone: TZ, courts, mode: "court" });
    expect(s.groups.map((g) => g.title)).toEqual(["Centre Court", "Court 2", NO_COURT_TITLE]);
    expect(s.groups[0].items.map((x) => x.id)).toEqual(["t1", "t2", "t5"]);
    expect(s.groups[2].items.map((x) => x.id)).toEqual(["t4"]);
  });

  it("pins what is live whatever the day", () => {
    const s = scheduleForDay(list, { day: "2026-11-03", timeZone: TZ, courts, mode: "court" });
    expect(s.live.map((x) => x.id)).toEqual(["t2"]);
    expect(s.groups.flatMap((g) => g.items.map((x) => x.id))).toEqual(["x"]);
  });

  it("an unknown court id counts as no court", () => {
    const s = scheduleForDay([item("z", { courtId: "gone", scheduledTime: "2026-11-02T08:00:00Z" })], { day: "2026-11-02", timeZone: TZ, courts, mode: "court" });
    expect(s.groups[0].title).toBe(NO_COURT_TITLE);
  });

  it("keeps a court's order across the hour when order numbers interleave", () => {
    const s = scheduleForDay(
      [
        item("late", { order: 1, scheduledTime: "2026-11-02T14:00:00Z" }),
        item("early", { order: 2, scheduledTime: "2026-11-02T07:00:00Z" }),
        item("after-early", { order: 3, startedAt: "2026-11-02T09:00:00Z" }),
      ],
      { day: "2026-11-02", timeZone: TZ, courts, mode: "court" },
    );
    expect(s.groups[0].items.map((x) => x.id)).toEqual(["early", "after-early", "late"]);
  });
});

describe("a day by time", () => {
  it("groups by start slot in the event's zone, courts in order, untimed last", () => {
    const s = scheduleForDay(
      [
        item("b", { courtId: "c2", order: 1, scheduledTime: "2026-11-02T08:00:00Z" }),
        item("a", { courtId: "c1", order: 2, scheduledTime: "2026-11-02T08:00:00Z" }),
        item("c", { courtId: "c1", order: 3, scheduledTime: "2026-11-02T11:30:00Z" }),
        item("d", { courtId: "c1", order: 4, startedAt: "2026-11-02T13:00:00Z" }),
      ],
      { day: "2026-11-02", timeZone: TZ, courts, mode: "time" },
    );
    expect(s.groups.map((g) => g.title)).toEqual(["10:00", "13:30", NO_TIME_TITLE]);
    expect(s.groups[0].items.map((x) => x.id)).toEqual(["a", "b"]);
    expect(s.groups[0].time).toBe("10:00");
  });
});
