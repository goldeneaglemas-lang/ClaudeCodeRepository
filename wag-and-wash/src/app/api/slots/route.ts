import { NextResponse } from "next/server";
import { getSettings, getSlots, MAX_RANGE_DAYS } from "@/lib/slots";
import { daysBetween, isValidDate } from "@/lib/time";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function badRequest(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

/**
 * GET /api/slots?serviceId=…&from=YYYY-MM-DD[&to=YYYY-MM-DD]
 * Free start times for a service on each day from `from` to `to` (shop dates).
 * The booking calendar asks for a month at a time.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const serviceId = params.get("serviceId") ?? "";
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? from;

  if (!UUID_RE.test(serviceId)) return badRequest("serviceId is missing or not valid.");
  if (!isValidDate(from) || !isValidDate(to)) return badRequest("Dates must look like 2026-11-03.");
  const span = daysBetween(from, to);
  if (span < 0) return badRequest("`to` must not be before `from`.");
  if (span >= MAX_RANGE_DAYS) return badRequest(`Ask for at most ${MAX_RANGE_DAYS} days at a time.`);

  const [days, settings] = await Promise.all([getSlots(serviceId, from, to), getSettings()]);
  if (!days) return NextResponse.json({ error: "That service isn't available." }, { status: 404 });

  return NextResponse.json(
    { timezone: settings.timezone, days },
    { headers: { "Cache-Control": "no-store" } },
  );
}
