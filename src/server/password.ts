/** argon2id password hashing (AUTH-1). OWASP-recommended parameters. */
import { hash, verify } from "@node-rs/argon2";

// @node-rs/argon2 defaults to Argon2id; these are the OWASP minimums (19 MiB, t=2, p=1).
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Burn the same time as a real verify when the user doesn't exist, so response
 * timing doesn't reveal which emails have accounts.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword("lavigo-dummy-password-for-timing");
  await verifyPassword(await dummyHash, password);
  return false;
}
