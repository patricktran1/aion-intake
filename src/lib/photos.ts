/**
 * Photo constraints and capture advisories.
 *
 * Everything here is about whether the image is *usable*, never about what is
 * in it. AION Intake does not classify lesions, does not estimate risk, and
 * does not look at photographs with a model. They are reference material the
 * dermatologist opens during the visit.
 */

export const MAX_PHOTOS = 3;
export const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;
export const MIN_DIMENSION = 400;
/** Client downscales to this longest edge before upload. Also strips EXIF. */
export const TARGET_LONG_EDGE = 1400;

export const ACCEPTED_MIME = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];

/**
 * Uploads are restricted to raster data URLs. SVG is markup, and markup
 * supplied by a stranger has no business being rendered next to a physician's
 * clinical brief — even inside an <img>, where it is mostly inert. The seeded
 * demo placeholders are SVG, but they come from this repository, not a request.
 */
export const ACCEPTED_DATA_URL_PREFIXES = [
  "data:image/jpeg;",
  "data:image/png;",
  "data:image/webp;",
  "data:image/jpg;",
];

export function isAcceptedDataUrl(dataUrl: string): boolean {
  return ACCEPTED_DATA_URL_PREFIXES.some((p) => dataUrl.startsWith(p));
}

export interface PhotoCheckInput {
  mime: string;
  bytes: number;
  width: number;
  height: number;
  /** Optional 0-1 sharpness proxy computed in the browser. */
  sharpness?: number;
  existingCount: number;
}

export interface PhotoCheckResult {
  ok: boolean;
  /** Blocking reason, shown to the patient in plain language. */
  error?: string;
  /** Non-blocking capture tips. The patient can always keep the photo anyway. */
  advisories: string[];
}

export function checkPhoto(input: PhotoCheckInput): PhotoCheckResult {
  const advisories: string[] = [];

  if (input.existingCount >= MAX_PHOTOS) {
    return { ok: false, error: `You can add up to ${MAX_PHOTOS} photos. Remove one to add another.`, advisories };
  }
  if (!ACCEPTED_MIME.includes(input.mime)) {
    return { ok: false, error: "That file type isn't supported. A photo from your camera roll works best.", advisories };
  }
  if (input.bytes > MAX_UPLOAD_BYTES) {
    return { ok: false, error: "That photo is too large to upload. Try taking it again at a normal size.", advisories };
  }
  if (input.bytes <= 0) {
    return { ok: false, error: "That file didn't upload correctly. Please try again.", advisories };
  }
  if (input.width < MIN_DIMENSION || input.height < MIN_DIMENSION) {
    return { ok: false, error: "That image is too small to be useful. A photo taken directly with your phone works best.", advisories };
  }

  const ratio = input.width / input.height;
  if (ratio > 3 || ratio < 1 / 3) {
    advisories.push("This looks like a screenshot or a crop — a straight photo of the area usually shows more.");
  }
  if (typeof input.sharpness === "number" && input.sharpness < 0.12) {
    advisories.push("This looks a little blurry. If it's easy, retake it with more light and hold still for a second.");
  }
  return { ok: true, advisories };
}

export const PHOTO_TIPS = [
  "Good light — near a window beats a bathroom mirror",
  "Hold steady and let the camera focus",
  "One wider photo showing the area in context",
  "One closer photo, about a hand's width away",
];

/**
 * Server-side image inspection — no image library, just header parsing.
 *
 * The client declares mime/width/height, but a hostile client can declare
 * anything, and every quality gate (MIN_DIMENSION, raster-only, the EXIF-free
 * privacy claim) is meaningless if it runs on attacker-controlled numbers. This
 * reads the actual bytes: magic numbers for the format, the format's own header
 * for dimensions, and the JPEG APP1 marker for EXIF.
 *
 * Deliberately not a decoder — it never looks at pixels, only at structure.
 */
export interface InspectedImage {
  mime: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
  /** JPEG only: an APP1/Exif segment is present (production clients strip it). */
  hasExif: boolean;
}

export function inspectImageBytes(bytes: Uint8Array): InspectedImage | null {
  if (bytes.length < 32) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A, then IHDR with width/height at offsets 16/20.
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const width = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
    const height = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
    if (width <= 0 || height <= 0) return null;
    return { mime: "image/png", width, height, hasExif: false };
  }

  // JPEG: FF D8, then marker segments; SOFn carries dimensions, APP1 "Exif" is EXIF.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let hasExif = false;
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null; // corrupt marker stream
      const marker = bytes[i + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = (bytes[i + 2] << 8) | bytes[i + 3];
      if (len < 2) return null;
      if (marker === 0xe1 && bytes[i + 4] === 0x45 && bytes[i + 5] === 0x78 && bytes[i + 6] === 0x69 && bytes[i + 7] === 0x66) {
        hasExif = true; // "Exif"
      }
      // SOF0..SOF15 except DHT(C4)/JPGA(C8)/DAC(CC) carry the frame header.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = (bytes[i + 5] << 8) | bytes[i + 6];
        const width = (bytes[i + 7] << 8) | bytes[i + 8];
        if (width <= 0 || height <= 0) return null;
        return { mime: "image/jpeg", width, height, hasExif };
      }
      i += 2 + len;
    }
    return null;
  }

  // WebP: RIFF....WEBP, then VP8 / VP8L / VP8X chunk.
  const ascii = (o: number, n: number) => String.fromCharCode(...bytes.slice(o, o + n));
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const chunk = ascii(12, 4);
    if (chunk === "VP8X" && bytes.length >= 30) {
      const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
      const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
      return { mime: "image/webp", width, height, hasExif: false };
    }
    if (chunk === "VP8 " && bytes.length >= 30) {
      const width = (bytes[26] | (bytes[27] << 8)) & 0x3fff;
      const height = (bytes[28] | (bytes[29] << 8)) & 0x3fff;
      if (width <= 0 || height <= 0) return null;
      return { mime: "image/webp", width, height, hasExif: false };
    }
    if (chunk === "VP8L" && bytes.length >= 25) {
      if (bytes[20] !== 0x2f) return null;
      const b = bytes;
      const width = 1 + (((b[22] & 0x3f) << 8) | b[21]);
      const height = 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6));
      return { mime: "image/webp", width, height, hasExif: false };
    }
    return null;
  }

  return null;
}

/** Decode just enough of a data URL to inspect the image header. */
export function inspectDataUrl(dataUrl: string): InspectedImage | null {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const meta = dataUrl.slice(0, comma);
  const isBase64 = meta.includes(";base64");
  try {
    if (isBase64) {
      // 4KB of base64 is far more than any header needs.
      const head = dataUrl.slice(comma + 1, comma + 1 + 4096);
      const bin = atob(head.slice(0, head.length - (head.length % 4)));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      return inspectImageBytes(bytes);
    }
    return null; // production clients always send base64; anything else is rejected
  } catch {
    return null;
  }
}
