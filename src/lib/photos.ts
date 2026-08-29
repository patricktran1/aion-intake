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
