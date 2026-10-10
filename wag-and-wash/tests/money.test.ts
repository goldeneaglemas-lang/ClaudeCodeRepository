import { describe, expect, it } from "vitest";
import { balanceDueCents, formatCents } from "@/lib/money";

describe("money", () => {
  it("takes the deposit off the final price", () => {
    expect(balanceDueCents(8500, 2500)).toBe(6000);
  });

  it("never shows a negative balance", () => {
    expect(balanceDueCents(2000, 2500)).toBe(0);
  });

  it("formats dollars", () => {
    expect(formatCents(5500)).toBe("$55.00");
  });
});
