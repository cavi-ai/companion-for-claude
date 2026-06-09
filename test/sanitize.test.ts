import { describe, it, expect } from "vitest";
import { sanitize, sanitizeWithReport } from "../src/memory/sanitize";

const MASK = "‹REDACTED›";

describe("sanitize", () => {
  it("redacts an Anthropic key", () => {
    const out = sanitize("token sk-ant-oat01-abc123XYZ_def-456 here");
    expect(out).not.toContain("abc123XYZ");
    expect(out).toContain(MASK);
  });

  it("redacts GitHub tokens and PATs", () => {
    expect(sanitize("ghp_abcdefghijklmnopqrstuvwxyz0123")).toContain(MASK);
    expect(sanitize("github_pat_11ABCDEFG0_abcdefghijklmnopqrstuvwxyz")).toContain(MASK);
  });

  it("redacts Bearer tokens and AWS keys", () => {
    const b = sanitize("Authorization: Bearer abcdef12345678ghijklmno");
    expect(b).not.toContain("abcdef12345678ghijklmno");
    expect(b).toContain(MASK);
    expect(sanitize("id AKIAIOSFODNN7EXAMPLE end")).toContain(MASK);
  });

  it("masks the value of a secret assignment but keeps the key", () => {
    const out = sanitize('API_KEY="s3cr3tvalue123"');
    expect(out).toContain("API_KEY");
    expect(out).not.toContain("s3cr3tvalue123");

    const env = sanitize("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIabcdEXAMPLEKEY");
    expect(env).toContain("AWS_SECRET_ACCESS_KEY");
    expect(env).not.toContain("wJalrXUtnFEMIabcdEXAMPLEKEY");
  });

  it("leaves ordinary prose untouched", () => {
    const prose = "The cat sat on the mat and we shipped 0.5.1 today.";
    expect(sanitize(prose)).toBe(prose);
  });

  it("reports what it redacted", () => {
    const { redactions } = sanitizeWithReport("ghp_abcdefghijklmnopqrstuvwxyz0123 and TOKEN=abcdef123");
    const kinds = redactions.map((r) => r.kind);
    expect(kinds).toContain("github-token");
    expect(kinds).toContain("secret-assignment");
  });
});
