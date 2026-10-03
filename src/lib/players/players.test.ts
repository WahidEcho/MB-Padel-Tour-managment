import { describe, expect, it } from "vitest";
import { randomInt } from "crypto";
import { ACCESS_CODE_ALPHABET, formatAccessCode, isValidAccessCode, newAccessCode, normalizeAccessCode } from "./accessCode";
import { displayPhone, toE164, whatsAppDigits } from "./phone";
import { linkedRows, normalizePersonName, samePerson } from "./identity";
import { codeMessage, codesCsv, csvCell, mailtoLink, whatsAppLink } from "./share";

describe("access codes", () => {
  it("are 8 characters from the look-alike-free alphabet", () => {
    for (let i = 0; i < 200; i++) {
      const c = newAccessCode(randomInt);
      expect(c).toHaveLength(8);
      expect(isValidAccessCode(c)).toBe(true);
    }
    expect(ACCESS_CODE_ALPHABET).not.toMatch(/[01ILO]/);
    expect(ACCESS_CODE_ALPHABET).toHaveLength(31);
  });

  it("read whatever people type or paste", () => {
    expect(normalizeAccessCode("abcd-2345")).toBe("ABCD2345");
    expect(normalizeAccessCode("  AB CD 23 45 ")).toBe("ABCD2345");
    expect(normalizeAccessCode("abcd–2345")).toBe("ABCD2345");
    expect(normalizeAccessCode("ABCD٢٣٤٥")).toBe("ABCD2345");
    expect(normalizeAccessCode("Hi Adam, this is your code:\n\nABCD-2345\n\nGet the app")).toBe("ABCD2345");
  });

  it("refuse look-alikes and wrong lengths", () => {
    expect(isValidAccessCode("ABCD2345")).toBe(true);
    expect(isValidAccessCode("ABCD0345")).toBe(false);
    expect(isValidAccessCode("ABCDO345")).toBe(false);
    expect(isValidAccessCode("ABCD234")).toBe(false);
    expect(isValidAccessCode("abcd2345")).toBe(false);
  });

  it("display as two groups of four", () => {
    expect(formatAccessCode("abcd2345")).toBe("ABCD-2345");
  });
});

describe("phone numbers to E.164", () => {
  it("reads Egyptian mobiles every way they are written", () => {
    for (const s of ["01001234567", "0100 123 4567", "+201001234567", "00201001234567", "201001234567", "1001234567", "٠١٠٠١٢٣٤٥٦٧", "(010) 0123-4567"]) {
      expect(toE164(s), s).toBe("+201001234567");
    }
    expect(toE164("01112345678")).toBe("+201112345678");
    expect(toE164("01212345678")).toBe("+201212345678");
    expect(toE164("01512345678")).toBe("+201512345678");
  });

  it("keeps Egyptian landlines", () => {
    expect(toE164("0223456789")).toBe("+20223456789");
  });

  it("keeps international numbers", () => {
    expect(toE164("+81 90 1234 5678")).toBe("+819012345678");
    expect(toE164("0044 7700 900123")).toBe("+447700900123");
  });

  it("refuses what is not a usable number", () => {
    for (const s of ["", "   ", "abc", "a@b.com", "0131234567", "0100123456", "010012345678", "+0123456789", "12", "+1234567890123456"]) {
      expect(toE164(s), s).toBeNull();
    }
    expect(toE164(null)).toBeNull();
  });

  it("gives wa.me its digits and people a readable form", () => {
    expect(whatsAppDigits("+201001234567")).toBe("201001234567");
    expect(displayPhone("+201001234567")).toBe("+20 100 123 4567");
    expect(displayPhone("+447700900123")).toBe("+447700900123");
    expect(displayPhone(null)).toBe("");
  });
});

describe("one claim, several tournaments", () => {
  const adam = { id: "p1", full_name: "Adam Hassan", player_profile_id: null, phone: "+201001234567", email: "adam@example.com" };

  it("links the same name with the same phone or email", () => {
    expect(samePerson(adam, { id: "p2", full_name: "adam  hassan", phone: "+201001234567" })).toBe(true);
    expect(samePerson(adam, { id: "p3", full_name: "Ádam Hassan", email: "ADAM@example.com " })).toBe(true);
  });

  it("links a shared persistent profile whatever the name", () => {
    expect(samePerson({ ...adam, player_profile_id: "prof" }, { id: "p4", full_name: "A. Hassan", player_profile_id: "prof" })).toBe(true);
  });

  it("does not link a sibling on the same parent's phone", () => {
    expect(samePerson(adam, { id: "p5", full_name: "Omar Hassan", phone: "+201001234567" })).toBe(false);
  });

  it("does not link on name alone", () => {
    expect(samePerson(adam, { id: "p6", full_name: "Adam Hassan", phone: null, email: null })).toBe(false);
    expect(samePerson({ ...adam, phone: null, email: null }, { id: "p7", full_name: "Adam Hassan", phone: null, email: null })).toBe(false);
  });

  it("filters candidates", () => {
    const rows = [
      { id: "p1", full_name: "Adam Hassan", phone: "+201001234567" },
      { id: "p2", full_name: "Adam Hassan", phone: "+201001234567" },
      { id: "p5", full_name: "Omar Hassan", phone: "+201001234567" },
    ];
    expect(linkedRows(adam, rows).map((r) => r.id)).toEqual(["p2"]);
    expect(normalizePersonName("  Jean-Luc  Picard ")).toBe("jean luc picard");
  });
});

describe("sharing a code", () => {
  const text = codeMessage({ playerName: "Adam Hassan", tournamentName: "Junior Finals", code: "ABCD2345" });

  it("writes the message with the code and the app link", () => {
    expect(text).toContain("Hi Adam,");
    expect(text).toContain("ABCD-2345");
    expect(text).toContain("https://mb-tournament.vercel.app/movescore");
  });

  it("builds a wa.me link to the player's number", () => {
    const link = whatsAppLink("+201001234567", text);
    expect(link.startsWith("https://wa.me/201001234567?text=")).toBe(true);
    expect(decodeURIComponent(link.split("text=")[1]!)).toBe(text);
    expect(whatsAppLink(null, "x")).toBe("https://wa.me/?text=x");
  });

  it("builds a mailto link with %20 spaces", () => {
    const link = mailtoLink("adam@example.com", "Your code", "Hi Adam");
    expect(link).toBe("mailto:adam@example.com?subject=Your%20code&body=Hi%20Adam");
  });

  it("writes a safe CSV", () => {
    expect(csvCell('Say "hi", Adam')).toBe('"Say ""hi"", Adam"');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("+201001234567", { phone: true })).toBe("+201001234567");
    expect(csvCell("+SUM(1)", { phone: true })).toBe("'+SUM(1)");
    const csv = codesCsv([{ name: "Adam Hassan", team: "Egypt", code: "ABCD2345", phone: "+201001234567", email: null, linked: true }]);
    expect(csv).toBe("player,team,code,phone,email,linked\nAdam Hassan,Egypt,ABCD-2345,+201001234567,,yes\n");
  });
});
