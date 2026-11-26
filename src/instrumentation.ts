/** Runs once when the Next.js server starts: fail fast on bad env (prod refuses to boot without keys). */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertEnv } = await import("./server/env");
    const { logger } = await import("./server/logger");
    const env = assertEnv();
    logger.info({ providers: env.providers, nodeEnv: env.NODE_ENV }, "web starting");
  }
}
