import { TARGET_LONG_EDGE } from "@/lib/photos";

/**
 * Browser-side image preparation.
 *
 * Two jobs, both non-diagnostic:
 *  1. Downscale and re-encode as JPEG. Re-encoding through a canvas discards
 *     all EXIF metadata, including GPS coordinates, before the image leaves the
 *     device. That is a privacy feature, not an optimisation.
 *  2. Compute a crude sharpness proxy so we can offer "this looks a bit blurry,
 *     want to retake it?" — advice about the photograph, never about the skin.
 */

export interface PreparedImage {
  dataUrl: string;
  width: number;
  height: number;
  mime: string;
  sharpness: number;
}

export async function prepareImage(file: File): Promise<PreparedImage> {
  const bitmap = await loadBitmap(file);
  const scale = Math.min(1, TARGET_LONG_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas_unavailable");
  ctx.drawImage(bitmap as CanvasImageSource, 0, 0, width, height);

  const sharpness = estimateSharpness(ctx, width, height);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
  if ("close" in bitmap && typeof bitmap.close === "function") bitmap.close();

  return { dataUrl, width, height, mime: "image/jpeg", sharpness };
}

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      /* fall through to the <img> path, e.g. for HEIC on some browsers */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("decode_failed"));
      img.src = url;
    });
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5_000);
  }
}

/**
 * Mean absolute Laplacian on a downsampled grayscale copy, normalised to 0-1.
 * Good enough to catch a genuinely smeared photo; deliberately not more.
 */
function estimateSharpness(ctx: CanvasRenderingContext2D, width: number, height: number): number {
  const w = Math.min(220, width);
  const h = Math.max(1, Math.round((height / width) * w));
  let data: Uint8ClampedArray;
  try {
    const small = document.createElement("canvas");
    small.width = w;
    small.height = h;
    const sctx = small.getContext("2d");
    if (!sctx) return 1;
    sctx.drawImage(ctx.canvas, 0, 0, w, h);
    data = sctx.getImageData(0, 0, w, h).data;
  } catch {
    return 1; // Never block an upload because a measurement failed.
  }

  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i += 1) {
    const o = i * 4;
    gray[i] = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
  }

  let sum = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x;
      const lap =
        4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
      sum += Math.abs(lap);
      n += 1;
    }
  }
  if (n === 0) return 1;
  // ~14 units of mean |Laplacian| is a comfortably crisp phone photo.
  return Math.min(1, sum / n / 14);
}
