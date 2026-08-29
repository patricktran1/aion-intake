import { describe, expect, it } from "vitest";
import { MAX_PHOTOS, MAX_UPLOAD_BYTES, checkPhoto } from "@/lib/photos";

const base = { mime: "image/jpeg", bytes: 900_000, width: 1400, height: 1050, existingCount: 0 };

describe("photo upload constraints", () => {
  it("accepts an ordinary phone photo", () => {
    expect(checkPhoto(base).ok).toBe(true);
  });

  it("caps the number of photos", () => {
    const r = checkPhoto({ ...base, existingCount: MAX_PHOTOS });
    expect(r.ok).toBe(false);
    expect(r.error).toContain(String(MAX_PHOTOS));
  });

  it("rejects a file that is not an image type we can display", () => {
    expect(checkPhoto({ ...base, mime: "application/pdf" }).ok).toBe(false);
  });

  it("rejects an oversized upload", () => {
    expect(checkPhoto({ ...base, bytes: MAX_UPLOAD_BYTES + 1 }).ok).toBe(false);
  });

  it("rejects a failed or empty upload", () => {
    expect(checkPhoto({ ...base, bytes: 0 }).ok).toBe(false);
  });

  it("rejects an image too small to be useful", () => {
    expect(checkPhoto({ ...base, width: 120, height: 90 }).ok).toBe(false);
  });

  it("advises but does not block on a blurry photo", () => {
    const r = checkPhoto({ ...base, sharpness: 0.05 });
    expect(r.ok).toBe(true);
    expect(r.advisories.join(" ")).toContain("blurry");
  });

  it("advises but does not block on an extreme crop", () => {
    const r = checkPhoto({ ...base, width: 1600, height: 420 });
    expect(r.ok).toBe(true);
    expect(r.advisories).toHaveLength(1);
  });

  it("says nothing about the skin, only about the photograph", () => {
    const r = checkPhoto({ ...base, sharpness: 0.05 });
    const text = r.advisories.join(" ").toLowerCase();
    for (const word of ["lesion", "mole", "cancer", "benign", "concerning", "diagnos"]) {
      expect(text).not.toContain(word);
    }
  });
});
