/**
 * Minimal structurally-valid image payloads for route tests.
 *
 * inspectImageBytes reads headers, never pixels, so a valid marker stream with
 * the right dimensions is a genuine test double for "a real photo" — and an
 * arbitrary base64 blob is a genuine test double for "not a photo".
 */

function toBase64(bytes: number[]): string {
  return Buffer.from(Uint8Array.from(bytes)).toString("base64");
}

/** A JPEG whose SOF0 header declares the given dimensions. */
export function jpegDataUrl(width: number, height: number, opts: { exif?: boolean; padTo?: number } = {}): string {
  const bytes: number[] = [0xff, 0xd8];
  if (opts.exif) {
    // APP1 "Exif\0\0" + a few filler bytes.
    const payload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x49, 0x49, 0x2a, 0x00];
    bytes.push(0xff, 0xe1, 0x00, payload.length + 2, ...payload);
  }
  // SOF0: len=17, precision 8, height, width, 3 components.
  bytes.push(
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  );
  // Pad with a COM segment so byte-size gates can be exercised.
  const padTo = opts.padTo ?? 4000;
  const padLen = Math.max(0, Math.min(65533, padTo - bytes.length - 4));
  bytes.push(0xff, 0xfe, ((padLen + 2) >> 8) & 0xff, (padLen + 2) & 0xff, ...new Array(padLen).fill(0));
  bytes.push(0xff, 0xd9);
  return `data:image/jpeg;base64,${toBase64(bytes)}`;
}

/** A PNG whose IHDR declares the given dimensions. */
export function pngDataUrl(width: number, height: number): string {
  const bytes: number[] = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    (width >> 24) & 0xff, (width >> 16) & 0xff, (width >> 8) & 0xff, width & 0xff,
    (height >> 24) & 0xff, (height >> 16) & 0xff, (height >> 8) & 0xff, height & 0xff,
    0x08, 0x02, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, // fake CRC — the inspector does not verify CRCs
  ];
  bytes.push(...new Array(3000).fill(0));
  return `data:image/png;base64,${toBase64(bytes)}`;
}

/** Not an image at all, dressed in an image data-URL prefix. */
export function fakeImageDataUrl(bytes = 4000): string {
  return `data:image/jpeg;base64,${"A".repeat(bytes)}`;
}
