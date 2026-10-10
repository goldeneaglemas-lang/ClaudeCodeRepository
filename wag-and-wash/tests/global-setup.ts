// Gives each test run its own brand-new database: created here, migrated and
// seeded from scratch (so the tests check the real constraints), and dropped
// when the run ends. It never wipes an existing database.
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

function loadEnvFile() {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

function withDatabase(serverUrl: string, dbName: string): string {
  const u = new URL(serverUrl);
  u.pathname = `/${dbName}`;
  return u.toString();
}

export default async function setup() {
  loadEnvFile();
  const serverUrl = process.env.TEST_DATABASE_SERVER_URL;
  if (!serverUrl) throw new Error("Set TEST_DATABASE_SERVER_URL (see .env.example) to run the tests.");

  const dbName = `wagwash_test_${randomBytes(4).toString("hex")}`;
  const admin = new PrismaClient({ datasources: { db: { url: withDatabase(serverUrl, "postgres") } } });
  await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);

  const url = withDatabase(serverUrl, dbName);
  // Test workers inherit these, so the app code under test (src/lib/prisma.ts)
  // talks to this run's database too.
  process.env.TEST_DATABASE_URL = url;
  process.env.DATABASE_URL = url;
  const env = { ...process.env, DATABASE_URL: url };
  execSync("npx prisma migrate deploy", { stdio: "ignore", env });
  execSync("npx prisma db seed", { stdio: "ignore", env });

  return async () => {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.$disconnect();
  };
}
