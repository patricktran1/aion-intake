/**
 * S3-compatible object store.
 *
 * Signature Version 4 over fetch, with no SDK. The reason is proportion: the
 * product needs four operations against one bucket, and the AWS SDK is tens of
 * megabytes of dependency, its own credential-resolution behaviour, and a
 * supply-chain surface — for PUT, GET, DELETE and LIST. SigV4 is a documented,
 * stable algorithm and the whole implementation is below.
 *
 * Works against any S3-compatible endpoint (AWS, Cloudflare R2, MinIO, Backblaze),
 * which keeps the pilot's storage decision reversible.
 *
 * The bucket must be private. Nothing here produces a public or pre-signed URL:
 * bytes are fetched by the server, after authorization, and streamed to the
 * viewer. A pre-signed URL would be a bearer token for a photograph, forwardable
 * and unrevokable, which is exactly the property the patient-token work removed.
 */

import { createHash, createHmac } from "node:crypto";
import { isSafeKey, type ObjectStore, type StoredObject } from "./index";

export interface S3Config {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** For non-AWS providers. Defaults to AWS's regional endpoint. */
  endpoint?: string;
}

const sha256Hex = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding for each path segment; S3 requires slashes preserved. */
const encodeKey = (key: string) =>
  key
    .split("/")
    .map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");

export class S3ObjectStore implements ObjectStore {
  readonly kind = "s3" as const;
  private readonly cfg: S3Config;

  constructor(cfg: S3Config) {
    this.cfg = cfg;
  }

  private host(): string {
    if (this.cfg.endpoint) return new URL(this.cfg.endpoint).host;
    return `${this.cfg.bucket}.s3.${this.cfg.region}.amazonaws.com`;
  }

  private url(path: string, query = ""): string {
    const scheme = this.cfg.endpoint ? new URL(this.cfg.endpoint).protocol : "https:";
    // Path-style addressing for custom endpoints (MinIO and friends default to
    // it); virtual-host style for AWS, where it is the only supported form.
    const base = this.cfg.endpoint ? `${scheme}//${this.host()}/${this.cfg.bucket}` : `${scheme}//${this.host()}`;
    return `${base}${path}${query ? `?${query}` : ""}`;
  }

  private sign(
    method: string,
    path: string,
    query: string,
    payload: Buffer | "",
    extraHeaders: Record<string, string> = {},
  ): Record<string, string> {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256Hex(payload === "" ? "" : payload);

    const headers: Record<string, string> = {
      host: this.cfg.endpoint ? this.host() : this.host(),
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...extraHeaders,
    };
    const signedHeaders = Object.keys(headers)
      .map((h) => h.toLowerCase())
      .sort();
    const canonicalHeaders = signedHeaders.map((h) => `${h}:${String(headers[h]).trim()}\n`).join("");
    const signedHeaderList = signedHeaders.join(";");

    const canonicalPath = this.cfg.endpoint ? `/${this.cfg.bucket}${path}` : path;
    const canonicalRequest = [
      method,
      canonicalPath,
      query,
      canonicalHeaders,
      signedHeaderList,
      payloadHash,
    ].join("\n");

    const scope = `${dateStamp}/${this.cfg.region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

    const kDate = hmac(`AWS4${this.cfg.secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, this.cfg.region);
    const kService = hmac(kRegion, "s3");
    const kSigning = hmac(kService, "aws4_request");
    const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

    return {
      ...headers,
      authorization:
        `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaderList}, Signature=${signature}`,
    };
  }

  async put(key: string, body: Buffer, contentType: string): Promise<StoredObject> {
    if (!isSafeKey(key)) throw new Error("unsafe object key");
    const path = `/${encodeKey(key)}`;
    const headers = this.sign("PUT", path, "", body, {
      "content-type": contentType,
      // Server-side encryption is requested explicitly rather than assumed
      // from a bucket default, so a misconfigured bucket fails loudly here.
      "x-amz-server-side-encryption": "AES256",
    });
    const res = await fetch(this.url(path), { method: "PUT", headers, body: new Uint8Array(body) });
    if (!res.ok) throw new Error(`s3 put failed: ${res.status}`);
    return { key, bytes: body.byteLength };
  }

  async get(key: string): Promise<{ body: Buffer; contentType: string } | null> {
    if (!isSafeKey(key)) throw new Error("unsafe object key");
    const path = `/${encodeKey(key)}`;
    const res = await fetch(this.url(path), { method: "GET", headers: this.sign("GET", path, "", "") });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`s3 get failed: ${res.status}`);
    return {
      body: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  async delete(key: string): Promise<boolean> {
    if (!isSafeKey(key)) throw new Error("unsafe object key");
    const path = `/${encodeKey(key)}`;
    const res = await fetch(this.url(path), { method: "DELETE", headers: this.sign("DELETE", path, "", "") });
    return res.status === 204 || res.status === 200 || res.status === 404;
  }

  async exists(key: string): Promise<boolean> {
    if (!isSafeKey(key)) return false;
    const path = `/${encodeKey(key)}`;
    const res = await fetch(this.url(path), { method: "HEAD", headers: this.sign("HEAD", path, "", "") });
    return res.ok;
  }

  async list(prefix: string): Promise<string[]> {
    const query = `list-type=2&prefix=${encodeURIComponent(prefix)}`;
    const res = await fetch(this.url("/", query), { method: "GET", headers: this.sign("GET", "/", query, "") });
    if (!res.ok) throw new Error(`s3 list failed: ${res.status}`);
    const xml = await res.text();
    return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
  }
}
