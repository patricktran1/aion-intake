/**
 * Object storage for photographs.
 *
 * Four properties, and the interface exists to make all four unavoidable
 * rather than remembered:
 *
 *   Private        Nothing here produces a URL a browser can fetch directly.
 *                  Bytes reach a viewer only through a route that has already
 *                  checked who they are — see api/intake/photo/[photoId].
 *   Unguessable    Keys carry 128 bits of randomness, so knowing an intake id
 *                  does not let you construct a photo key.
 *   Scoped         Keys are prefixed by practice and intake, so a misdirected
 *                  read is visible in the key itself and lifecycle rules can
 *                  be written against a prefix.
 *   Deletable      Deletion is part of the interface, not an afterthought,
 *                  because retention is a product requirement.
 *
 * The local adapter is for development and for a single-instance pilot on a
 * mounted volume. The S3 adapter is the deployment target; both are exercised
 * by the same tests through this interface.
 */

import { randomBytes } from "node:crypto";

export interface StoredObject {
  key: string;
  bytes: number;
}

export interface ObjectStore {
  readonly kind: "local" | "s3";
  put(key: string, body: Buffer, contentType: string): Promise<StoredObject>;
  get(key: string): Promise<{ body: Buffer; contentType: string } | null>;
  delete(key: string): Promise<boolean>;
  exists(key: string): Promise<boolean>;
  /** Keys under a prefix. Used by the retention job and by tests. */
  list(prefix: string): Promise<string[]>;
}

/**
 * Photo keys.
 *
 * `practice/intake/random.ext`. The random component is what makes the key
 * unguessable; the prefixes make ownership legible and let a bucket lifecycle
 * rule target one practice if a pilot ends.
 */
export function photoKey(practiceId: string, intakeId: string, mime: string): string {
  const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
  return `${practiceId}/${intakeId}/${randomBytes(16).toString("hex")}.${ext}`;
}

/** Guards against a key from a request escaping its prefix. */
export function isSafeKey(key: string): boolean {
  if (key.length === 0 || key.length > 300) return false;
  if (key.startsWith("/") || key.includes("..") || key.includes("\\")) return false;
  return /^[A-Za-z0-9_\-/.]+$/.test(key);
}
