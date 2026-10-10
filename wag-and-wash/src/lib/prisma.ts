import { PrismaClient } from "@prisma/client";

// Reuse one client across hot reloads in development, so we don't open a new
// pool of database connections on every file save.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
