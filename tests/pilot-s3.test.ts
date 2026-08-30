import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { S3ObjectStore } from "@/lib/objects/s3";
import { AddressInfo } from "node:net";

/**
 * The S3 adapter, against a mock S3 endpoint.
 *
 * The point is not to test aws4fetch — that is a maintained library. The point
 * is to prove that the adapter drives it correctly: that every request carries
 * a SigV4 Authorization header, that the URL and method are right for each
 * operation, that encryption is requested on upload, and that the CRUD
 * lifecycle round-trips. A tiny in-process server stands in for S3, records
 * what it receives, and returns S3-shaped responses.
 */

interface Recorded {
  method: string;
  path: string;
  query: string;
  auth: string | null;
  sse: string | null;
  contentType: string | null;
  body: Buffer;
}

const store = new Map<string, { body: Buffer; contentType: string }>();
let received: Recorded[] = [];
let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      // Path-style: /<bucket>/<key...>
      const parts = url.pathname.replace(/^\//, "").split("/");
      const key = parts.slice(1).join("/");
      received.push({
        method: req.method ?? "",
        path: url.pathname,
        query: url.search.replace(/^\?/, ""),
        auth: req.headers.authorization ?? null,
        sse: (req.headers["x-amz-server-side-encryption"] as string) ?? null,
        contentType: (req.headers["content-type"] as string) ?? null,
        body: Buffer.concat(chunks),
      });

      const method = req.method;
      if (method === "PUT") {
        store.set(key, { body: Buffer.concat(chunks), contentType: String(req.headers["content-type"] ?? "") });
        res.writeHead(200).end();
      } else if (method === "GET" && url.search.includes("list-type")) {
        const prefix = url.searchParams.get("prefix") ?? "";
        const keys = [...store.keys()].filter((k) => k.startsWith(prefix));
        res
          .writeHead(200, { "content-type": "application/xml" })
          .end(`<ListBucketResult>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join("")}</ListBucketResult>`);
      } else if (method === "GET") {
        const obj = store.get(key);
        if (!obj) res.writeHead(404).end();
        else res.writeHead(200, { "content-type": obj.contentType }).end(obj.body);
      } else if (method === "HEAD") {
        res.writeHead(store.has(key) ? 200 : 404).end();
      } else if (method === "DELETE") {
        store.delete(key);
        res.writeHead(204).end();
      } else {
        res.writeHead(400).end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.close();
});

const makeStore = () =>
  new S3ObjectStore({
    bucket: "aion-photos",
    region: "us-east-1",
    accessKeyId: "AKIAEXAMPLE0000000000",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    endpoint: `http://localhost:${port}`,
  });

describe("S3 adapter drives aws4fetch correctly", () => {
  it("round-trips an object through put, get, exists and delete", async () => {
    received = [];
    const s3 = makeStore();
    const key = "prac_a/int_1/deadbeef.jpg";
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

    const put = await s3.put(key, bytes, "image/jpeg");
    expect(put.bytes).toBe(bytes.byteLength);

    const got = await s3.get(key);
    expect(got).not.toBeNull();
    expect(Buffer.compare(got!.body, bytes)).toBe(0);
    expect(got!.contentType).toBe("image/jpeg");

    expect(await s3.exists(key)).toBe(true);
    expect(await s3.delete(key)).toBe(true);
    expect(await s3.exists(key)).toBe(false);
    expect(await s3.get(key)).toBeNull();
  });

  it("signs every request with SigV4", async () => {
    received = [];
    const s3 = makeStore();
    await s3.put("prac_a/int_1/x.jpg", Buffer.from("hi"), "image/jpeg");
    await s3.get("prac_a/int_1/x.jpg");
    await s3.delete("prac_a/int_1/x.jpg");

    expect(received.length).toBeGreaterThanOrEqual(3);
    for (const r of received) {
      expect(r.auth, `${r.method} ${r.path} must be signed`).toMatch(/^AWS4-HMAC-SHA256 /);
      expect(r.auth).toContain("Credential=AKIAEXAMPLE0000000000/");
      expect(r.auth).toContain("SignedHeaders=");
      expect(r.auth).toContain("Signature=");
    }
  });

  it("requests server-side encryption on upload", async () => {
    received = [];
    const s3 = makeStore();
    await s3.put("prac_a/int_1/enc.jpg", Buffer.from("secret"), "image/jpeg");
    const put = received.find((r) => r.method === "PUT")!;
    expect(put.sse).toBe("AES256");
    expect(put.contentType).toBe("image/jpeg");
  });

  it("addresses the right bucket, key and path style", async () => {
    received = [];
    const s3 = makeStore();
    await s3.put("prac_x/int_9/photo.png", Buffer.from("x"), "image/png");
    const put = received.find((r) => r.method === "PUT")!;
    expect(put.path).toBe("/aion-photos/prac_x/int_9/photo.png");
    // The slashes in the key are preserved, not percent-encoded away.
    expect(put.path).not.toContain("%2F");
  });

  it("lists only keys under a prefix", async () => {
    received = [];
    const s3 = makeStore();
    await s3.put("prac_list/int_1/a.jpg", Buffer.from("a"), "image/jpeg");
    await s3.put("prac_list/int_2/b.jpg", Buffer.from("b"), "image/jpeg");
    await s3.put("other/int_3/c.jpg", Buffer.from("c"), "image/jpeg");

    const listed = await s3.list("prac_list/");
    expect(listed).toContain("prac_list/int_1/a.jpg");
    expect(listed).toContain("prac_list/int_2/b.jpg");
    expect(listed).not.toContain("other/int_3/c.jpg");
    const listReq = received.find((r) => r.query.includes("list-type"));
    expect(listReq?.auth).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it("rejects an unsafe key before signing or sending anything", async () => {
    received = [];
    const s3 = makeStore();
    await expect(s3.put("../escape.jpg", Buffer.from("x"), "image/jpeg")).rejects.toThrow(/unsafe/);
    expect(received).toHaveLength(0);
  });

  it("surfaces a provider error rather than silently succeeding", async () => {
    // A 500 from storage must not read as a stored photo.
    const broken = createServer((_req, res) => res.writeHead(500).end("boom"));
    await new Promise<void>((r) => broken.listen(0, r));
    const p = (broken.address() as AddressInfo).port;
    try {
      const s3 = new S3ObjectStore({
        bucket: "b", region: "us-east-1", accessKeyId: "AKIA0", secretAccessKey: "s",
        endpoint: `http://localhost:${p}`,
      });
      await expect(s3.put("a/b/c.jpg", Buffer.from("x"), "image/jpeg")).rejects.toThrow(/s3 put failed: 500/);
    } finally {
      broken.close();
    }
  }, 15_000);
});
