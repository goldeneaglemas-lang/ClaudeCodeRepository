import { describe, expect, it } from "vitest";
import { normalizeUsPhone } from "@/lib/phone";

describe("normalizeUsPhone", () => {
  it.each([
    ["(555) 234-5678", "+15552345678"],
    ["555.234.5678", "+15552345678"],
    ["1 555 234 5678", "+15552345678"],
    ["+1-555-234-5678", "+15552345678"],
  ])("accepts %s", (input, expected) => {
    expect(normalizeUsPhone(input)).toBe(expected);
  });

  it.each(["", "234-5678", "555 234 56789", "(055) 234-5678", "(555) 134-5678", "+44 20 7946 0958"])("rejects %s", (input) => {
    expect(normalizeUsPhone(input)).toBeNull();
  });
});
