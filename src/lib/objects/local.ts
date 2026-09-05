/**
 * Filesystem object store.
 *
 * For local development, for the synthetic pilot, and for a single-instance
 * pilot on an encrypted volume. Files land under a configured root with the
 * same key layout the S3 adapter uses, so switching between them changes a
 * configuration value and nothing else.
 *
 * The root is created on demand and every key is validated before it touches
 * the filesystem: a key is attacker-influenced data, and `../` in one would
 * otherwise be a path traversal straight out of the storage directory.
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { isSafeKey, type ObjectStore, type StoredObject } from "./index";

const CONTENT_TYPE_SUFFIX = ".type";

export class LocalObjectStore implements ObjectStore {
  readonly kind = "local" as const;
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /**
   * Resolves a key to an absolute path, then proves the result is still inside
   * the root. Two checks rather than one because the shape test and the
   * resolved-path test fail on different tricks, and this is the boundary
   * where getting it wrong reads arbitrary files.
   */
  private pathFor(key: string): string {
    if (!isSafeKey(key)) throw new Error("unsafe object key");
    const full = resolve(join(this.root, key));
    const rel = relative(this.root, full);
    if (rel.startsWith("..") || rel.startsWith(sep) || resolve(full) !== full) {
      throw new Error("object key escapes storage root");
    }
    return full;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<StoredObject> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    // The content type travels beside the object so a read does not have to
    // guess from the extension, and so the stored value is whatever the
    // server determined from the bytes rather than what a client claimed.
    await writeFile(`${path}${CONTENT_TYPE_SUFFIX}`, contentType, "utf8");
    return { key, bytes: body.byteLength };
  }

  async get(key: string): Promise<{ body: Buffer; contentType: string } | null> {
    const path = this.pathFor(key);
    try {
      const body = await readFile(path);
      const contentType = await readFile(`${path}${CONTENT_TYPE_SUFFIX}`, "utf8").catch(
        () => "application/octet-stream",
      );
      return { body, contentType: contentType.trim() };
    } catch {
      return null;
    }
  }

  /**
   * True means the object is confirmed absent. `force` makes an already-missing
   * key succeed — the sweeper retries until it gets a true, so "already gone"
   * must not read as failure. A real filesystem error (permissions, a busy
   * handle) still throws out of `rm` and is reported as false.
   */
  async delete(key: string): Promise<boolean> {
    const path = this.pathFor(key);
    try {
      await rm(path, { force: true });
      await rm(`${path}${CONTENT_TYPE_SUFFIX}`, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (!e.name.endsWith(CONTENT_TYPE_SUFFIX)) {
          out.push(relative(this.root, full).split(sep).join("/"));
        }
      }
    };
    await walk(this.root);
    return out.filter((k) => k.startsWith(prefix)).sort();
  }
}
