import { hash, verify, Algorithm } from '@node-rs/argon2';

// OWASP-recommended argon2id parameters (19 MiB, 2 iterations, parallelism 1).
// @node-rs/argon2 ships prebuilt binaries, so there is no node-gyp toolchain in
// the Docker image.
const options = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, options);
}

export async function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashed, plain, options);
  } catch {
    // A malformed or truncated hash must read as "wrong password", never as a
    // 500 that distinguishes this account from any other.
    return false;
  }
}
