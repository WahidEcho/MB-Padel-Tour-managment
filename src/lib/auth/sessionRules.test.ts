import { describe, expect, it } from "vitest";
import { isSessionRevoked, refreshVerdict, SESSION_RETRY, SESSION_REVOKED } from "./sessionRules";

describe("refreshVerdict", () => {
  it("treats Supabase's dead-refresh-token answers as final", () => {
    expect(refreshVerdict({ name: "AuthApiError", status: 400, code: "refresh_token_not_found", message: "Invalid Refresh Token: Refresh Token Not Found" })).toBe("revoked");
    expect(refreshVerdict({ name: "AuthApiError", status: 400, code: "refresh_token_already_used" })).toBe("revoked");
    expect(refreshVerdict({ name: "AuthApiError", status: 403, code: "session_not_found" })).toBe("revoked");
    expect(refreshVerdict({ name: "AuthApiError", status: 400, message: "Invalid Refresh Token: Already Used" })).toBe("revoked");
  });

  it("never signs out on network trouble, rate limits or server errors", () => {
    expect(refreshVerdict({ name: "AuthRetryableFetchError", status: 0, message: "fetch failed" })).toBe("retry");
    expect(refreshVerdict({ name: "AuthRetryableFetchError", status: 503 })).toBe("retry");
    expect(refreshVerdict({ name: "AuthApiError", status: 429, code: "over_request_rate_limit" })).toBe("retry");
    expect(refreshVerdict({ name: "AuthApiError", status: 500, message: "Database error" })).toBe("retry");
    expect(refreshVerdict({ name: "AuthUnknownError", status: 502 })).toBe("retry");
    expect(refreshVerdict(null)).toBe("retry");
  });
});

describe("isSessionRevoked", () => {
  it("is true only for a 401 that says the session was revoked", () => {
    expect(isSessionRevoked(401, { code: SESSION_REVOKED })).toBe(true);
    expect(isSessionRevoked(401, { error: "Signed out. Sign in again." })).toBe(false); // older server: not definitive
    expect(isSessionRevoked(503, { code: SESSION_RETRY })).toBe(false);
    expect(isSessionRevoked(500, null)).toBe(false);
    expect(isSessionRevoked(429, { code: SESSION_REVOKED })).toBe(false);
  });
});
