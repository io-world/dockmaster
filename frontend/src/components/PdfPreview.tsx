// Page PNGs stacked vertically with boxes absolutely positioned over them.
// Positions come from geometry.ts only; each page tracks its own rendered width with a ResizeObserver.
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Rnd } from "react-rnd";
import type { BBox, Page } from "../api";
import { bboxToPx, pageScale, pxToBbox, pxToPoint } from "../geometry";

const RESIZE_ENABLED = { right: true, bottom: true, bottomRight: true, top: false, left: false, topLeft: false, topRight: false, bottomLeft: false };
const RESIZE_HANDLES = {
  right: { width: 6, right: -7, top: 0, height: "100%", cursor: "ew-resize" },
  bottom: { height: 6, bottom: -7, left: 0, width: "100%", cursor: "ns-resize" },
  bottomRight: { width: 10, height: 10, right: -10, bottom: -10, cursor: "nwse-resize" },
};

export interface PageClick {
  page: number;
  point: [number, number]; // PDF points
  clientX: number;
  clientY: number;
}

interface EditProps {
  onBoxChange?: (id: string, bbox: BBox) => void; // makes boxes movable/resizable
  addMode?: boolean;
  onPageClick?: (c: PageClick) => void;
}

export interface PreviewBox {
  id: string;
  page: number;
  bbox: BBox;
  color: string;
  dashed?: boolean;
  label?: string;
  title?: string;
  muted?: boolean; // e.g. other signers' fields on the signing page
  pulse?: boolean; // briefly animate (card -> box link)
  content?: { kind: "text" | "check" | "radio"; value: string }; // preview of a filled value
}

// Same look as stamp.py: Helvetica, dark blue, largest size up to 11pt (and 75% of the box height) that fits.
const STAMP_COLOR = "#00008c";
const AVG_CHAR_EM = 0.5; // Helvetica's average character width, in em

function fitSizePt(text: string, w: number, h: number): number {
  for (let size = Math.max(Math.min(11, h * 0.75), 4); size >= 4; size -= 0.5) {
    const lines = Math.ceil((text.length * AVG_CHAR_EM * size) / Math.max(w - 2, 1));
    if (lines * size * 1.15 <= h || (lines === 1 && size <= h)) return size;
  }
  return 4;
}

/** What the value will look like once stamped into the PDF. */
function BoxContent({ content, bbox, scale }: { content: NonNullable<PreviewBox["content"]>; bbox: BBox; scale: number }) {
  const w = bbox[2] - bbox[0];
  const h = bbox[3] - bbox[1];
  if (content.kind === "radio")
    return (
      <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <span className="rounded-full" style={{ width: "55%", height: "55%", background: STAMP_COLOR }} />
      </span>
    );
  const text = content.kind === "check" ? "X" : content.value;
  return (
    <span
      data-testid="box-value"
      className="pointer-events-none absolute inset-0 overflow-hidden break-words px-px"
      style={{ color: STAMP_COLOR, fontFamily: "Helvetica, Arial, sans-serif", fontSize: fitSizePt(text, w, h) * scale, lineHeight: 1.15 }}
    >
      {text}
    </span>
  );
}

function PageView({
  page,
  boxes,
  highlighted,
  onBoxClick,
  renderBox,
  onBoxChange,
  addMode,
  onPageClick,
}: {
  page: Page;
  boxes: PreviewBox[];
  highlighted: Set<string>;
  onBoxClick?: (id: string) => void;
  renderBox?: (box: PreviewBox, scale: number) => ReactNode;
} & EditProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setScale(pageScale(page.width, el.clientWidth));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [page.width]);

  const clickPage = (e: MouseEvent<HTMLDivElement>) => {
    if (!addMode || !onPageClick || !ref.current || scale <= 0) return;
    if ((e.target as HTMLElement).closest("[data-box-id]")) return;
    const r = ref.current.getBoundingClientRect();
    onPageClick({ page: page.n, point: pxToPoint(e.clientX - r.left, e.clientY - r.top, scale), clientX: e.clientX, clientY: e.clientY });
  };

  return (
    <div
      ref={ref}
      data-page={page.n}
      onClick={clickPage}
      className={`relative w-full scroll-mt-16 bg-white shadow ${addMode ? "cursor-crosshair" : ""}`}
      style={{ aspectRatio: `${page.width} / ${page.height}` }} // reserves space before the image loads
    >
      {failed ? (
        <div className="flex h-full items-center justify-center text-sm text-red-700">Couldn't load page {page.n}</div>
      ) : (
        <img
          src={page.image_url}
          alt={`Page ${page.n}`}
          className="absolute inset-0 h-full w-full select-none"
          draggable={false}
          onError={() => setFailed(true)}
        />
      )}
      {scale > 0 &&
        boxes.map((b) => {
          if (renderBox) return renderBox(b, scale);
          const r = bboxToPx(b.bbox, scale);
          const hi = highlighted.has(b.id);
          const style = {
            border: `${hi ? 3 : 2}px ${b.dashed ? "dashed" : "solid"} ${b.color}`,
            background: b.muted ? "rgba(148,163,184,0.15)" : b.content ? "rgba(255,255,255,0.35)" : `${b.color}14`,
            opacity: b.muted ? 0.5 : 1,
            boxShadow: hi ? `0 0 0 3px ${b.color}55` : undefined,
          };
          const tag = b.label && (
            <span
              className="pointer-events-none absolute -top-3.5 left-0 whitespace-nowrap rounded-sm px-0.5 text-[9px] leading-[14px] text-white"
              style={{ background: b.color }}
            >
              {b.label}
            </span>
          );
          if (onBoxChange) {
            // Editable: drag to move, handles to resize. Selection uses a normal click (also fires after a drag,
            // which simply selects the box that was moved).
            return (
              <Rnd
                key={b.id}
                bounds="parent"
                size={{ width: r.width, height: r.height }}
                position={{ x: r.left, y: r.top }}
                minWidth={6}
                minHeight={6}
                // Handles sit just outside the box (right, bottom, corner only). react-rnd's default handles straddle
                // every edge and cover thin boxes entirely, so clicks/drags on a 10px-tall field hit a resize handle.
                enableResizing={RESIZE_ENABLED}
                resizeHandleStyles={RESIZE_HANDLES}
                className={`${hi ? "z-10" : ""} ${b.pulse ? "box-pulse" : ""}`}
                style={style}
                onDragStop={(_e, d) => {
                  if (Math.abs(d.x - r.left) >= 1 || Math.abs(d.y - r.top) >= 1)
                    onBoxChange(b.id, pxToBbox({ left: d.x, top: d.y, width: r.width, height: r.height }, scale, page));
                }}
                onResizeStop={(_e, _dir, el, _delta, pos) =>
                  onBoxChange(b.id, pxToBbox({ left: pos.x, top: pos.y, width: el.offsetWidth, height: el.offsetHeight }, scale, page))
                }
              >
                <div data-box-id={b.id} title={b.title} className="h-full w-full cursor-move" onClick={() => onBoxClick?.(b.id)}>
                  {b.content && <BoxContent content={b.content} bbox={b.bbox} scale={scale} />}
                  {tag}
                </div>
              </Rnd>
            );
          }
          return (
            <div
              key={b.id}
              data-box-id={b.id}
              title={b.title}
              onClick={onBoxClick ? () => onBoxClick(b.id) : undefined}
              className={`absolute ${onBoxClick ? "cursor-pointer" : ""} ${hi ? "z-10" : ""} ${b.pulse ? "box-pulse" : ""}`}
              style={{ left: r.left, top: r.top, width: r.width, height: r.height, ...style }}
            >
              {b.content && <BoxContent content={b.content} bbox={b.bbox} scale={scale} />}
              {b.label && (
                <span
                  className="pointer-events-none absolute -top-3.5 left-0 whitespace-nowrap rounded-sm px-0.5 text-[9px] leading-[14px] text-white"
                  style={{ background: b.color }}
                >
                  {b.label}
                </span>
              )}
            </div>
          );
        })}
      <span className="absolute -left-1 top-1 -translate-x-full text-xs text-gray-400">{page.n}</span>
    </div>
  );
}

export default function PdfPreview({
  pages,
  boxes,
  highlighted = new Set(),
  onBoxClick,
  renderBox,
  onBoxChange,
  addMode,
  onPageClick,
}: {
  pages: Page[];
  boxes: PreviewBox[];
  highlighted?: Set<string>;
  onBoxClick?: (id: string) => void;
  renderBox?: (box: PreviewBox, scale: number) => ReactNode;
} & EditProps) {
  if (pages.length === 0) return <p className="text-sm text-gray-600">This document has no pages to show.</p>;
  return (
    <div className="space-y-4 pl-6">
      {pages.map((p) => (
        <PageView
          key={p.n}
          page={p}
          boxes={boxes.filter((b) => b.page === p.n)}
          highlighted={highlighted}
          onBoxClick={onBoxClick}
          renderBox={renderBox}
          onBoxChange={onBoxChange}
          addMode={addMode}
          onPageClick={onPageClick}
        />
      ))}
    </div>
  );
}
