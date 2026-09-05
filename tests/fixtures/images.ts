/**
 * Minimal structurally-valid image payloads for route tests.
 *
 * inspectImageBytes reads headers, never pixels, so a valid marker stream with
 * the right dimensions is a genuine test double for "a real photo" — and an
 * arbitrary base64 blob is a genuine test double for "not a photo".
 *
 * The metadata options here exist because the privacy claim ("a photograph
 * carrying location data is refused") was only ever true for a JPEG APP1
 * segment placed before the frame header. Everything else — a PNG eXIf chunk, a
 * WebP EXIF chunk, an APP1 after the SOF, an APP1 carrying XMP — went through.
 */

function toBase64(bytes: number[]): string {
  return Buffer.from(Uint8Array.from(bytes)).toString("base64");
}

export interface JpegOpts {
  /** APP1 "Exif" before the frame header — the one case that was caught. */
  exif?: boolean;
  /** The same segment AFTER the frame header, where the old scan stopped. */
  exifAfterSof?: boolean;
  /** APP1 carrying XMP, which can hold coordinates and is not "Exif". */
  xmp?: boolean;
  /** A COM comment segment: attacker-supplied text riding with the image. */
  comment?: boolean;
  padTo?: number;
}

/** A JPEG whose SOF0 header declares the given dimensions. */
export function jpegDataUrl(width: number, height: number, opts: JpegOpts = {}): string {
  const bytes: number[] = [0xff, 0xd8];
  // APP0/JFIF: what a browser canvas actually emits, and the only APPn a clean
  // re-encode contains.
  bytes.push(0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00);

  const exifSegment = () => {
    const payload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x49, 0x49, 0x2a, 0x00];
    return [0xff, 0xe1, 0x00, payload.length + 2, ...payload];
  };
  if (opts.exif) bytes.push(...exifSegment());
  if (opts.xmp) {
    // APP1 whose payload is the XMP namespace rather than "Exif".
    const payload = [..."http://ns.adobe.com/xap/1.0/\0"].map((c) => c.charCodeAt(0));
    bytes.push(0xff, 0xe1, ((payload.length + 2) >> 8) & 0xff, (payload.length + 2) & 0xff, ...payload);
  }
  if (opts.comment) {
    const payload = [..."hello"].map((c) => c.charCodeAt(0));
    bytes.push(0xff, 0xfe, 0x00, payload.length + 2, ...payload);
  }

  // SOF0: len=17, precision 8, height, width, 3 components.
  bytes.push(
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  );

  if (opts.exifAfterSof) bytes.push(...exifSegment());

  // Start of scan, then filler standing in for entropy-coded data. Padding
  // goes here rather than in a COM segment: real image bytes live after SOS,
  // and a comment segment is itself metadata.
  bytes.push(0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00);
  const padTo = opts.padTo ?? 4000;
  bytes.push(...new Array(Math.max(0, padTo - bytes.length - 2)).fill(0x55));
  bytes.push(0xff, 0xd9);
  return `data:image/jpeg;base64,${toBase64(bytes)}`;
}

function pngChunk(type: string, data: number[] = []): number[] {
  return [
    (data.length >> 24) & 0xff, (data.length >> 16) & 0xff, (data.length >> 8) & 0xff, data.length & 0xff,
    ...[...type].map((c) => c.charCodeAt(0)),
    ...data,
    0x00, 0x00, 0x00, 0x00, // fake CRC — the inspector does not verify CRCs
  ];
}

/** A PNG whose IHDR declares the given dimensions. */
export function pngDataUrl(
  width: number,
  height: number,
  opts: { exif?: boolean; text?: boolean } = {},
): string {
  const bytes: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  bytes.push(
    ...pngChunk("IHDR", [
      (width >> 24) & 0xff, (width >> 16) & 0xff, (width >> 8) & 0xff, width & 0xff,
      (height >> 24) & 0xff, (height >> 16) & 0xff, (height >> 8) & 0xff, height & 0xff,
      0x08, 0x02, 0x00, 0x00, 0x00,
    ]),
  );
  // PNG's own EXIF container. Holds a complete EXIF block, GPS included.
  if (opts.exif) bytes.push(...pngChunk("eXIf", [0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]));
  if (opts.text) bytes.push(...pngChunk("tEXt", [..."Comment\0anything"].map((c) => c.charCodeAt(0))));
  bytes.push(...pngChunk("IDAT", new Array(3000).fill(0)));
  bytes.push(...pngChunk("IEND"));
  return `data:image/png;base64,${toBase64(bytes)}`;
}

/**
 * An extended-format (VP8X) WebP. The flags byte declares whether the file
 * carries EXIF (0x08) or XMP (0x04) — which the inspector used to ignore
 * entirely, returning "no metadata" for every WebP ever uploaded.
 */
export function webpDataUrl(
  width: number,
  height: number,
  opts: { exif?: boolean; xmp?: boolean } = {},
): string {
  const flags = (opts.exif ? 0x08 : 0) | (opts.xmp ? 0x04 : 0);
  const w = width - 1;
  const h = height - 1;
  const bytes: number[] = [
    ...[..."RIFF"].map((c) => c.charCodeAt(0)),
    0x00, 0x00, 0x00, 0x00, // file size, unchecked
    ...[..."WEBP"].map((c) => c.charCodeAt(0)),
    ...[..."VP8X"].map((c) => c.charCodeAt(0)),
    0x0a, 0x00, 0x00, 0x00, // chunk length
    flags, 0x00, 0x00, 0x00,
    w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff,
    h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff,
  ];
  bytes.push(...new Array(3000).fill(0));
  return `data:image/webp;base64,${toBase64(bytes)}`;
}

/** Not an image at all, dressed in an image data-URL prefix. */
export function fakeImageDataUrl(bytes = 4000): string {
  return `data:image/jpeg;base64,${"A".repeat(bytes)}`;
}
