/**
 * Chooses the object store from configuration.
 *
 * Demo mode has none: demo photos are data URLs inside the in-memory record,
 * which is the right call for something that resets on a button press and
 * holds nothing real. Asking for an object store in demo mode is a bug in the
 * caller, so it throws rather than silently returning a local one that would
 * quietly start writing files next to a public demo.
 */

import { isPilot, pilotConfig } from "@/lib/config/runtime";
import type { ObjectStore } from "./index";
import { LocalObjectStore } from "./local";

const globalForObjects = globalThis as unknown as { __aionObjects?: ObjectStore };

export async function objectStore(): Promise<ObjectStore> {
  if (globalForObjects.__aionObjects) return globalForObjects.__aionObjects;
  if (!isPilot()) throw new Error("objectStore() is not available in demo mode");

  const cfg = pilotConfig().objectStore;
  if (cfg.kind === "local") {
    globalForObjects.__aionObjects = new LocalObjectStore(cfg.root);
  } else {
    const { S3ObjectStore } = await import("./s3");
    globalForObjects.__aionObjects = new S3ObjectStore({
      bucket: cfg.bucket,
      region: cfg.region,
      endpoint: cfg.endpoint,
      accessKeyId: process.env.AION_S3_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.AION_S3_SECRET_ACCESS_KEY ?? "",
    });
  }
  return globalForObjects.__aionObjects;
}

/** Test hook: install a store, or clear it so the next call rebuilds. */
export function setObjectStore(s: ObjectStore | null): void {
  if (s) globalForObjects.__aionObjects = s;
  else delete globalForObjects.__aionObjects;
}
