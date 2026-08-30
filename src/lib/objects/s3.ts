/**
 * S3-compatible object store.
 *
 * Signing is delegated to `aws4fetch` — a small, single-purpose, widely-used
 * SigV4-over-fetch library — rather than the hand-rolled implementation this
 * file used to carry. The previous version worked in tests, but a hand-written
 * request-signing algorithm guarding photographs of patients' skin is exactly
 * the kind of code that should not be bespoke: a subtle canonicalisation bug
 * would be invisible until it either failed to authenticate or, worse, signed
 * something it should not. aws4fetch is the maintained implementation of the
 * same algorithm, and it is 65KB with no dependencies.
 *
 * Works against any S3-compatible endpoint (AWS, Cloudflare R2, MinIO,
 * Backblaze), which keeps the pilot's storage decision reversible.
 *
 * The bucket must be private. Nothing here produces a public or pre-signed URL:
 * bytes are fetched by the server, after authorization, and streamed to the
 * viewer. A pre-signed URL would be a bearer token for a photograph,
 * forwardable and unrevokable — the property the patient-token work removed.
 */

import { AwsClient } from "aws4fetch";
import { isSafeKey, type ObjectStore, type StoredObject } from "./index";

export interface S3Config {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** For non-AWS providers (R2, MinIO). Defaults to AWS's regional endpoint. */
  endpoint?: string;
}

/** RFC 3986 encoding per path segment; S3 requires slashes preserved. */
const encodeKey = (key: string) =>
  key
    .split("/")
    .map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");

export class S3ObjectStore implements ObjectStore {
  readonly kind = "s3" as const;
  private readonly cfg: S3Config;
  private readonly aws: AwsClient;

  constructor(cfg: S3Config) {
    this.cfg = cfg;
    this.aws = new AwsClient({
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      region: cfg.region,
      service: "s3",
      // One retry, not the default of many. A photo upload is on the patient's
      // request path, and the store surfaces OBJECT_STORE_UNAVAILABLE for the
      // caller to retry deliberately — a long internal backoff would just make
      // the patient stare at a spinner.
      retries: 1,
    });
  }

  private base(): string {
    if (this.cfg.endpoint) {
      // Path-style for custom endpoints (MinIO, and R2 when addressed that way).
      const u = new URL(this.cfg.endpoint);
      return `${u.protocol}//${u.host}/${this.cfg.bucket}`;
    }
    // Virtual-host style for AWS, its only supported form.
    return `https://${this.cfg.bucket}.s3.${this.cfg.region}.amazonaws.com`;
  }

  private url(key: string): string {
    return `${this.base()}/${encodeKey(key)}`;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<StoredObject> {
    if (!isSafeKey(key)) throw new Error("unsafe object key");
    const res = await this.aws.fetch(this.url(key), {
      method: "PUT",
      body: new Uint8Array(body),
      headers: {
        "content-type": contentType,
        // Encryption requested explicitly rather than assumed from a bucket
        // default, so a misconfigured bucket fails loudly here.
        "x-amz-server-side-encryption": "AES256",
      },
    });
    if (!res.ok) throw new Error(`s3 put failed: ${res.status}`);
    return { key, bytes: body.byteLength };
  }

  async get(key: string): Promise<{ body: Buffer; contentType: string } | null> {
    if (!isSafeKey(key)) throw new Error("unsafe object key");
    const res = await this.aws.fetch(this.url(key), { method: "GET" });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`s3 get failed: ${res.status}`);
    return {
      body: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  async delete(key: string): Promise<boolean> {
    if (!isSafeKey(key)) throw new Error("unsafe object key");
    const res = await this.aws.fetch(this.url(key), { method: "DELETE" });
    return res.status === 204 || res.status === 200 || res.status === 404;
  }

  async exists(key: string): Promise<boolean> {
    if (!isSafeKey(key)) return false;
    const res = await this.aws.fetch(this.url(key), { method: "HEAD" });
    return res.ok;
  }

  async list(prefix: string): Promise<string[]> {
    const url = `${this.base()}?list-type=2&prefix=${encodeURIComponent(prefix)}`;
    const res = await this.aws.fetch(url, { method: "GET" });
    if (!res.ok) throw new Error(`s3 list failed: ${res.status}`);
    const xml = await res.text();
    return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
  }
}
