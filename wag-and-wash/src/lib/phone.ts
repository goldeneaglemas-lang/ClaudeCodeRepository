/**
 * Turns what a customer types into a US phone number in E.164 form
 * ("(555) 123-4567" -> "+15551234567"). Returns null if it isn't one.
 */
export function normalizeUsPhone(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (national.length !== 10) return null;
  // US area codes and exchanges never start with 0 or 1.
  if (/^[01]/.test(national) || /^[01]/.test(national.slice(3))) return null;
  return `+1${national}`;
}
