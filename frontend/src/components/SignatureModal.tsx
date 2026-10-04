// Draw (signature_pad) or type (script font) a signature. Output: a transparent PNG data URL trimmed to the ink,
// so it fills the field's box when stamped (a wide empty canvas would shrink the signature to a sliver).
import { useEffect, useRef, useState } from "react";
import SignaturePad from "signature_pad";

export const SCRIPT_FONT = '"Dancing Script", "Brush Script MT", cursive';

/** Crop a canvas to its non-transparent pixels (plus padding) and return a PNG data URL, or null if empty. */
function trimmedPng(canvas: HTMLCanvasElement, pad = 8): string | null {
  const ctx = canvas.getContext("2d")!;
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (data[(y * width + x) * 4 + 3] > 10) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return null;
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(width - 1, x1 + pad);
  y1 = Math.min(height - 1, y1 + pad);
  const out = document.createElement("canvas");
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext("2d")!.drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL("image/png");
}

/** A typed name rendered in the script font: a transparent, trimmed PNG data URL (null for empty text). */
export async function textSignaturePng(text: string): Promise<string | null> {
  const t = text.trim();
  if (!t) return null;
  try {
    await document.fonts.load(`64px ${SCRIPT_FONT}`);
  } catch {
    /* fall back to whatever cursive font is available */
  }
  const c = document.createElement("canvas");
  c.width = 1200;
  c.height = 220;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#0b2a6f";
  ctx.font = `96px ${SCRIPT_FONT}`;
  ctx.textBaseline = "middle";
  ctx.fillText(t, 20, 110, 1160);
  return trimmedPng(c);
}

export default function SignatureModal({
  kind,
  defaultName,
  onDone,
  onCancel,
}: {
  kind: "signature" | "initials";
  defaultName: string;
  onDone: (png: string) => void;
  onCancel: () => void;
}) {
  const initials = defaultName
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  const [mode, setMode] = useState<"draw" | "type">("draw");
  const [typed, setTyped] = useState(kind === "initials" ? initials : defaultName);
  const [empty, setEmpty] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const padRef = useRef<SignaturePad | null>(null);

  useEffect(() => {
    if (mode !== "draw" || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    canvas.width = canvas.offsetWidth * ratio;
    canvas.height = canvas.offsetHeight * ratio;
    canvas.getContext("2d")!.scale(ratio, ratio);
    const pad = new SignaturePad(canvas, { penColor: "#0b2a6f", backgroundColor: "rgba(0,0,0,0)" });
    pad.addEventListener("endStroke", () => setEmpty(pad.isEmpty()));
    padRef.current = pad;
    setEmpty(true);
    return () => pad.off();
  }, [mode]);

  const typedPng = () => textSignaturePng(typed);

  const done = async () => {
    const png = mode === "draw" ? (canvasRef.current ? trimmedPng(canvasRef.current) : null) : await typedPng();
    if (png) onDone(png);
  };

  const canFinish = mode === "draw" ? !empty : typed.trim().length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg space-y-3 rounded bg-white p-4 shadow-xl" role="dialog" data-testid="signature-modal">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold">{kind === "initials" ? "Add your initials" : "Add your signature"}</h2>
          <div className="ml-auto flex rounded border text-sm">
            <button className={`px-3 py-1 ${mode === "draw" ? "bg-gray-100 font-medium" : ""}`} onClick={() => setMode("draw")}>
              Draw
            </button>
            <button className={`px-3 py-1 ${mode === "type" ? "bg-gray-100 font-medium" : ""}`} onClick={() => setMode("type")}>
              Type your name
            </button>
          </div>
        </div>

        {mode === "draw" ? (
          <div>
            <canvas ref={canvasRef} data-testid="signature-canvas" className="h-40 w-full touch-none rounded border border-dashed bg-gray-50" />
            <div className="mt-1 flex text-xs text-gray-500">
              <span>Draw with your mouse or finger.</span>
              <button
                className="ml-auto underline"
                onClick={() => {
                  padRef.current?.clear();
                  setEmpty(true);
                }}
              >
                Clear
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={kind === "initials" ? "Your initials" : "Your full name"}
              className="w-full rounded border px-2 py-1.5"
              autoFocus
            />
            <div className="flex h-24 items-center overflow-hidden rounded border bg-gray-50 px-3 text-5xl text-[#0b2a6f]" style={{ fontFamily: SCRIPT_FONT }}>
              {typed || <span className="text-base text-gray-400" style={{ fontFamily: "inherit" }}>Preview</span>}
            </div>
          </div>
        )}

        <p className="text-xs text-gray-500">By clicking Apply, you agree this is your electronic {kind === "initials" ? "initials" : "signature"}.</p>
        <div className="flex justify-end gap-2">
          <button className="rounded border px-3 py-1.5 text-sm" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-50"
            disabled={!canFinish}
            onClick={done}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
