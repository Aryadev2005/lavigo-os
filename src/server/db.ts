/** Prisma client singleton (survives Next dev hot reloads). */
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { __lavigoPrisma?: PrismaClient };

export const db: PrismaClient =
  globalForPrisma.__lavigoPrisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.__lavigoPrisma = db;

export type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];
