/**
 * Runs once when the Next.js server starts: fail fast on bad env (prod refuses to boot without keys).
 * Next logs a throwing register() and keeps serving, so exit explicitly: a container with bad env
 * must die (and restart-loop visibly), not serve requests that crash later.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertEnv } = await import("./server/env");
    const { logger } = await import("./server/logger");
    let env;
    try {
      env = assertEnv();
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
    logger.info({ providers: env.providers, nodeEnv: env.NODE_ENV }, "web starting");
  }
}
