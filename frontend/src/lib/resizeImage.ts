/**
 * Downscale an image File to a small data URL suitable for storing inline (e.g.
 * an agent avatar in localStorage). Loads via an object URL, draws onto a canvas
 * capped at `max` px on the long edge, and encodes as JPEG to keep the string
 * small. Browser-only (needs <canvas>); call it from a user gesture, never
 * during render/SSR.
 */
export async function resizeImageToDataUrl(
  file: File,
  max = 256,
  type = "image/jpeg",
  quality = 0.85,
): Promise<string> {
  const img = await loadImage(file);
  const longEdge = Math.max(img.width, img.height) || 1;
  const scale = Math.min(1, max / longEdge);
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");
  ctx.drawImage(img, 0, 0, width, height);
  return canvas.toDataURL(type, quality);
}

/** Load a File into an HTMLImageElement via a transient object URL. */
function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to load image"));
    };
    img.src = url;
  });
}
