import { describe, expect, it } from "vitest";
import {
  ESCALATE_SECONDS,
  MAX_REMINDERS,
  REMINDER_SECONDS,
  closedCallShown,
  elapsedClock,
  escalationDue,
  isCallAnswer,
  masterAnswers,
  reminderDue,
  reminderRecipients,
  reminderWindows,
  type CallResponse,
} from "./rules";
import { CALL_WORDS, callLang, callWord } from "./callWords";

const T0 = Date.parse("2026-10-21T10:00:00.000Z");
const at = (s: number) => T0 + s * 1000;
const call = (over: Partial<{ status: "open" | "acknowledged" | "resolved" | "cancelled"; reminders_sent: number; escalated_at: string | null }> = {}) => ({
  status: "open" as const,
  requested_at: new Date(T0).toISOString(),
  reminders_sent: 0,
  escalated_at: null,
  ...over,
});
const resp = (refereeId: string, answer: "coming" | "declined", name = refereeId): CallResponse => ({ refereeId, name, answer, at: new Date(at(10)).toISOString() });

describe("calls for assistance: 10-second reminders", () => {
  it("one window per 10 s, none before", () => {
    expect(REMINDER_SECONDS).toBe(10);
    expect(reminderWindows(call().requested_at, at(9))).toBe(0);
    expect(reminderWindows(call().requested_at, at(10))).toBe(1);
    expect(reminderWindows(call().requested_at, at(29))).toBe(2);
    expect(reminderWindows(call().requested_at, at(-5))).toBe(0);
  });
  it("is due at 10 s, not at 9 s, and once per window", () => {
    expect(reminderDue(call(), at(9))).toBeNull();
    expect(reminderDue(call(), at(10))).toBe(1);
    expect(reminderDue(call({ reminders_sent: 1 }), at(15))).toBeNull();
    expect(reminderDue(call({ reminders_sent: 1 }), at(20))).toBe(2);
  });
  it("missed windows collapse into one reminder (the latest window)", () => {
    expect(reminderDue(call({ reminders_sent: 1 }), at(45))).toBe(4);
  });
  it("keeps ringing for ten minutes", () => {
    expect(MAX_REMINDERS * REMINDER_SECONDS).toBe(600);
  });
  it("stops after MAX_REMINDERS", () => {
    expect(reminderDue(call({ reminders_sent: MAX_REMINDERS }), at(3600))).toBeNull();
    expect(reminderDue(call({ reminders_sent: MAX_REMINDERS - 1 }), at(3600))).toBe(MAX_REMINDERS);
  });
  it("stops once a master took the call, or it closed", () => {
    for (const status of ["acknowledged", "resolved", "cancelled"] as const) expect(reminderDue(call({ status }), at(90))).toBeNull();
  });
  it("goes to the masters on duty who have not answered: a Decline excludes", () => {
    expect(reminderRecipients(["omar", "karim"], [])).toEqual(["omar", "karim"]);
    expect(reminderRecipients(["omar", "karim"], [resp("omar", "declined")])).toEqual(["karim"]);
    expect(reminderRecipients(["omar", "karim", "omar"], [resp("omar", "declined"), resp("karim", "declined")])).toEqual([]);
  });
});

describe("calls for assistance: escalation to the organiser", () => {
  it("at 2 minutes unanswered, and only once", () => {
    expect(ESCALATE_SECONDS).toBe(120);
    expect(escalationDue(call(), at(119))).toBe(false);
    expect(escalationDue(call(), at(120))).toBe(true);
    expect(escalationDue(call({ escalated_at: new Date(at(120)).toISOString() }), at(150))).toBe(false);
  });
  it("at once when every master on duty declined", () => {
    expect(escalationDue(call(), at(20), ["omar", "karim"], [resp("omar", "declined")])).toBe(false);
    expect(escalationDue(call(), at(20), ["omar", "karim"], [resp("omar", "declined"), resp("karim", "declined")])).toBe(true);
    // Nobody on duty: only the clock escalates.
    expect(escalationDue(call(), at(20), [], [])).toBe(false);
  });
  it("never once a master took it", () => {
    expect(escalationDue(call({ status: "acknowledged" }), at(600))).toBe(false);
  });
});

describe("calls for assistance: every master's answer for the chair umpire", () => {
  it("lists every master on duty: coming first, no answer, declined; names only", () => {
    const rows = masterAnswers(
      [
        { id: "omar", name: "Omar" },
        { id: "karim", name: "Karim" },
        { id: "sara", name: "Sara" },
      ],
      [resp("omar", "declined", "Omar"), resp("sara", "coming", "Sara")],
    );
    expect(rows.map((r) => [r.name, r.answer])).toEqual([
      ["Sara", "coming"],
      ["Karim", "none"],
      ["Omar", "declined"],
    ]);
    expect(rows.find((r) => r.name === "Karim")!.at).toBeNull();
    expect(Object.keys(rows[0]).sort()).toEqual(["answer", "at", "name"]);
  });
  it("keeps an answer of a master who went off duty", () => {
    expect(masterAnswers([], [resp("omar", "declined", "Omar")])).toEqual([{ name: "Omar", answer: "declined", at: new Date(at(10)).toISOString() }]);
  });
  it("answers are coming or declined only", () => {
    expect(isCallAnswer("coming")).toBe(true);
    expect(isCallAnswer("declined")).toBe(true);
    expect(isCallAnswer("acknowledge")).toBe(false);
  });
  it("a closed call shows for a minute, then hides", () => {
    const resolvedAt = new Date(T0).toISOString();
    expect(closedCallShown({ status: "resolved", resolvedAt }, at(59))).toBe(true);
    expect(closedCallShown({ status: "resolved", resolvedAt }, at(60))).toBe(false);
    expect(closedCallShown({ status: "cancelled", resolvedAt }, at(5))).toBe(true);
    expect(closedCallShown({ status: "open", resolvedAt: null }, at(5))).toBe(false);
  });
  it("the running clock", () => {
    expect(elapsedClock(new Date(T0).toISOString(), at(42))).toBe("0:42");
    expect(elapsedClock(new Date(T0).toISOString(), at(125))).toBe("2:05");
    expect(elapsedClock(new Date(T0).toISOString(), at(3725))).toBe("1:02:05");
    expect(elapsedClock(new Date(T0).toISOString(), at(-3))).toBe("0:00");
  });
});

describe("calls for assistance: the words in English, Spanish and French", () => {
  it("the owner's wording in English", () => {
    expect(callWord("en", "goingBody", { name: "Sara", court: "Court 2" })).toBe("Master referee Sara is going to the emergency call at Court 2");
    expect(callWord("en", "reminderBody", { court: "Court 2" })).toBe("Court 2 still needs a master referee — tap to answer");
    expect(callWord("en", "isComing", { name: "Sara", court: "Court 2" })).toBe("Sara is coming to Court 2");
    expect(callWord("en", "pushBody", { name: "Sara", court: "Court 3" })).toBe("Chair umpire Sara is calling for assistance at Court 3");
  });
  it("every language has every key with the same placeholders", () => {
    const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
    for (const key of Object.keys(CALL_WORDS.en) as (keyof typeof CALL_WORDS.en)[]) {
      for (const lang of ["es", "fr"] as const) {
        expect(CALL_WORDS[lang][key], `${lang}.${key}`).toBeTruthy();
        expect(holes(CALL_WORDS[lang][key]), `${lang}.${key}`).toBe(holes(CALL_WORDS.en[key]));
      }
    }
  });
  it("picks the phone's language", () => {
    expect(callLang("es-ES")).toBe("es");
    expect(callLang("fr_CA")).toBe("fr");
    expect(callLang("en-GB")).toBe("en");
    expect(callLang("ar-EG")).toBe("en");
    expect(callLang(null)).toBe("en");
    expect(callWord("es", "coming")).toBe("Voy");
    expect(callWord("fr", "decline")).toBe("Refuser");
  });
});

describe("calls for assistance: the reason (migration 0044)", () => {
  it("knows Rule and Medical and nothing else", async () => {
    const { ASSISTANCE_REASONS, cleanReason } = await import("./rules");
    expect(ASSISTANCE_REASONS).toEqual(["rules", "medical"]);
    expect(cleanReason("medical")).toBe("medical");
    expect(cleanReason("weather")).toBeNull();
    expect(cleanReason(undefined)).toBeNull();
  });
  it("says it in each language, first in the push", async () => {
    const { callWord, reasonText } = await import("./callWords");
    expect(callWord("en", "callFor_rules")).toBe("Call Referee for Rule");
    expect(callWord("en", "callFor_medical")).toBe("Call Referee for Medical");
    expect(reasonText("es", "medical")).toBe("Médico");
    expect(reasonText("fr", "rules")).toBe("Règlement");
    expect(reasonText("en", null)).toBeNull();
    expect(reasonText("en", "weather")).toBeNull();
    expect(callWord("en", "pushBodyReason", { reason: "Medical", name: "Sara", court: "Court 3" })).toBe("Medical · Chair umpire Sara at Court 3");
  });
});

describe("calls for assistance: no two pushes in a row", () => {
  it("an alert within ALERT_GAP_SECONDS holds the next one back", async () => {
    const { alertedRecently, ALERT_GAP_SECONDS } = await import("./rules");
    const t0 = Date.parse("2026-10-31T12:00:00Z");
    const at = new Date(t0).toISOString();
    expect(alertedRecently(at, t0 + 1000)).toBe(true);
    expect(alertedRecently(at, t0 + ALERT_GAP_SECONDS * 1000 - 1)).toBe(true);
    expect(alertedRecently(at, t0 + ALERT_GAP_SECONDS * 1000)).toBe(false);
    expect(alertedRecently(null, t0)).toBe(false);
  });
});

