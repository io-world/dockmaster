// The ONLY place that converts between PDF points and screen pixels.
// Backend coordinates: PDF points (1/72 in), origin top-left, display space (page rotation already applied),
// matching the page PNGs. One scale factor per page: renderedImageWidthPx / page.width.
import type { BBox } from "./api";

export interface PxRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function pageScale(pageWidthPt: number, renderedWidthPx: number): number {
  return pageWidthPt > 0 ? renderedWidthPx / pageWidthPt : 0;
}

export function bboxToPx(b: BBox, scale: number): PxRect {
  return { left: b[0] * scale, top: b[1] * scale, width: (b[2] - b[0]) * scale, height: (b[3] - b[1]) * scale };
}

/** Inverse of bboxToPx, clamped to the page so a dragged box can't leave it. */
export function pxToBbox(r: PxRect, scale: number, page: { width: number; height: number }): BBox {
  const x0 = Math.max(0, Math.min(r.left / scale, page.width - 1));
  const y0 = Math.max(0, Math.min(r.top / scale, page.height - 1));
  const x1 = Math.max(x0 + 1, Math.min((r.left + r.width) / scale, page.width));
  const y1 = Math.max(y0 + 1, Math.min((r.top + r.height) / scale, page.height));
  return [round2(x0), round2(y0), round2(x1), round2(y1)];
}

/** A point clicked on the page image (px relative to the image) -> PDF points. */
export function pxToPoint(xPx: number, yPx: number, scale: number): [number, number] {
  return [round2(xPx / scale), round2(yPx / scale)];
}

const round2 = (v: number) => Math.round(v * 100) / 100;
