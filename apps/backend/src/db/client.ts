import { PrismaClient } from "@prisma/client";
import { env } from "@/config/env";
import { logger } from "@/utils/logger";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export async function connectPrisma(): Promise<void> {
  try {
    await prisma.$connect();
    logger.info("Prisma connected");
  } catch (err) {
    logger.error("Prisma connection failed", { err });
    throw err;
  }
}
