/**
 * Runs in every test worker before any test file: refuse to run against anything but the
 * separate <db>_test database that global-setup created, so tests can never read or write the
 * dev (or any real) database, even if vitest.config's DATABASE_URL rewrite is bypassed.
 */
const url = process.env.DATABASE_URL;
if (url) {
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!name.endsWith("_test")) {
    throw new Error(`Tests must use a *_test database, got "${name}". Run them through vitest (make test).`);
  }
}
