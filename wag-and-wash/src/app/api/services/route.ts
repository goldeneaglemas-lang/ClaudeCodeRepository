import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/** GET /api/services: the services customers can book, in Jess's order. */
export async function GET() {
  const services = await prisma.service.findMany({
    where: { active: true },
    orderBy: { sortOrder: "asc" },
    select: { id: true, name: true, description: true, durationMin: true, priceCents: true },
  });
  return NextResponse.json({ services });
}
