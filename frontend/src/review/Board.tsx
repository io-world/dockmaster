// Review board: vertical, collapsible sections plus a sticky drop bar.
// Every drop destination is always visible in the drop bar, so dragging never needs to scroll (autoScroll is off).
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Draft, Field, Party, Signer } from "../api";
import { FieldCard, RejectedCard, type Destination, type RadioInfo } from "./Card";
import {
  acceptField,
  addSigner,
  byPosition,
  moveFieldTo,
  newGroupId,
  rejectedKey,
  removeField,
  removeSigner,
  restoreRejected,
  setFieldType,
  setFieldValue,
  setRadioChoice,
  setRadioGroup,
  setSelf,
  updateSigner,
  type DraftUpdate,
  type DropTarget,
} from "./draft";
import { groupName, needsReview, radioGroup, signerColor, TYPE_ICON, TYPE_LABEL, UNASSIGNED_COLOR } from "./model";
import { EMAIL_RE } from "./checklist";

const REJECTED_COLOR = "#9ca3af";
/** Which section a field is shown in: its signer's, or Needs review. */
export const sectionOf = (f: Field) => (needsReview(f) ? "review" : (f.signer_id ?? "review"));

const badEmail = (s: Signer) => !s.email || !EMAIL_RE.test(s.email.trim());
const signerProblem = (s: Signer) => !s.name?.trim() || badEmail(s);
/** e.g. "needs name & email" */
const problemText = (s: Signer) => "needs " + [!s.name?.trim() && "name", badEmail(s) && "email"].filter(Boolean).join(" & ");

/** Chips win over sections that scroll underneath the sticky drop bar. */
const collision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  const chip = hits.find((h) => String(h.id).startsWith("chip:"));
  if (chip) return [chip];
  return hits.length ? hits : rectIntersection(args);
};

function Draggable({ id, children }: { id: string; children: ReactNode }) {
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({ id });
  return (
    <div ref={setNodeRef} {...listeners} {...attributes} className={isDragging ? "opacity-30" : ""}>
      {children}
    </div>
  );
}

function Droppable({ id, target, children, className }: { id: string; target: DropTarget; children: ReactNode; className?: string }) {
  const { setNodeRef, isOver } = useDroppable({ id, data: { target } });
  return (
    <div ref={setNodeRef} className={`${className ?? ""} ${isOver ? "ring-2 ring-blue-500" : ""}`}>
      {children}
    </div>
  );
}

/** One chip per destination, always visible at the top of the board. Drop a card on it, or click to jump. */
function DropBar({ items, dragging, onJump }: { items: (Destination & { color: string; count: number })[]; dragging: boolean; onJump: (key: string) => void }) {
  return (
    <div data-testid="drop-bar" className="sticky top-0 z-20 border-b bg-white/95 px-3 py-2 backdrop-blur">
      <div className="mb-1 text-xs text-gray-500">
        {dragging ? "Drop on a chip to move the field there" : "Drag a card onto a chip to move it · click a chip to jump to its section"}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((d) => (
          <Droppable key={d.key} id={`chip:${d.key}`} target={d.target} className="rounded-full">
            <button
              data-testid={`chip-${d.key}`}
              onClick={() => onJump(d.key)}
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${dragging ? "border-blue-300 bg-blue-50" : "border-gray-300 bg-white hover:bg-gray-50"}`}
            >
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: d.color }} />
              <span className="max-w-[10rem] truncate">{d.label}</span>
              <span className="text-gray-500">{d.count}</span>
            </button>
          </Droppable>
        ))}
      </div>
    </div>
  );
}

function Section({
  sectionKey,
  target,
  title,
  color,
  count,
  open,
  onToggle,
  onTitleClick,
  active,
  badges,
  header,
  children,
}: {
  sectionKey: string;
  target: DropTarget;
  title: string;
  color: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  onTitleClick?: () => void;
  active?: boolean;
  badges?: ReactNode;
  header?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Droppable id={`sec:${sectionKey}`} target={target} className="rounded border bg-gray-50">
      <section data-testid={`col-${sectionKey}`} data-section={sectionKey}>
        <div className={`flex items-center gap-2 border-l-4 px-2 py-2 ${active ? "bg-blue-50" : ""}`} style={{ borderLeftColor: color }}>
          <button
            data-testid={`toggle-${sectionKey}`}
            onClick={onToggle}
            className="w-5 shrink-0 text-gray-500 hover:text-gray-900"
            aria-expanded={open}
            title={open ? "Collapse" : "Expand"}
          >
            {open ? "▾" : "▸"}
          </button>
          <button
            onClick={onTitleClick ?? onToggle}
            className="min-w-0 truncate text-left font-medium"
            title={onTitleClick ? "Highlight these fields on the document" : undefined}
          >
            {title}
          </button>
          <div className="flex min-w-0 flex-wrap items-center gap-1">{badges}</div>
          <span className="ml-auto shrink-0 rounded bg-white px-1.5 text-xs text-gray-600">{count}</span>
        </div>
        {open && (
          <div className="space-y-2 px-3 pb-3">
            {header}
            {children}
          </div>
        )}
      </section>
    </Droppable>
  );
}

const Badge = ({ children, tone }: { children: ReactNode; tone: "red" | "gray" | "blue" }) => (
  <span
    className={`whitespace-nowrap rounded px-1.5 text-[11px] ${
      tone === "red" ? "bg-red-100 text-red-800" : tone === "blue" ? "bg-blue-100 text-blue-800" : "bg-gray-200 text-gray-700"
    }`}
  >
    {children}
  </span>
);

function SignerDetails({ signer, parties, apply }: { signer: Signer; parties: Party[]; apply: (u: DraftUpdate) => void }) {
  const party = parties.find((p) => p.id === signer.party_id);
  const role = signer.role || party?.role;
  const emailBad = !!signer.email && !EMAIL_RE.test(signer.email);
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <div className="space-y-1.5 rounded bg-white p-2 text-sm" onPointerDown={stop}>
      {(role || party?.name) && (
        <div className="text-xs text-gray-600">
          {role}
          {party?.name ? ` · ${party.name}` : ""}
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <input
          value={signer.name ?? ""}
          onChange={(e) => apply(updateSigner(signer.id, { name: e.target.value }))}
          placeholder="Full name"
          className="rounded border px-2 py-1"
        />
        <input
          value={signer.email ?? ""}
          onChange={(e) => apply(updateSigner(signer.id, { email: e.target.value }))}
          placeholder="Email"
          type="email"
          className={`rounded border px-2 py-1 ${emailBad ? "border-red-400" : ""}`}
        />
      </div>
      {emailBad && <div className="text-xs text-red-700">Enter a valid email</div>}
      <div className="flex items-center gap-3 text-xs">
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={signer.is_self} onChange={(e) => apply(setSelf(signer.id, e.target.checked))} />
          This is me
        </label>
        <button
          className="ml-auto text-gray-500 hover:text-red-700 hover:underline"
          onClick={() => apply(removeSigner(signer.id))}
          title="Remove this signer; their fields go back to Needs review"
        >
          Remove signer
        </button>
      </div>
    </div>
  );
}

const CARD_GRID = "grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(250px,1fr))]";

export default function Board({
  draft,
  parties,
  apply,
  selectedId,
  onSelect,
  activeSignerId,
  onSignerHeader,
  reveal,
}: {
  draft: Draft;
  parties: Party[];
  apply: (u: DraftUpdate) => void;
  selectedId: string | null;
  onSelect: (fieldId: string) => void;
  activeSignerId: string | null;
  onSignerHeader: (signerId: string) => void;
  reveal: { fieldId: string; nonce: number } | null; // box -> card: open its section and scroll to it
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  // Open/closed per section. Signer defaults are decided once (when first seen) so a section never collapses
  // itself while the sender is typing into it.
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    const few = draft.signers.length <= 3;
    return Object.fromEntries([
      ["review", true],
      ["rejected", false],
      ...draft.signers.map((s) => [s.id, few || signerProblem(s)]),
    ]);
  });
  useEffect(() => {
    const missing = draft.signers.filter((s) => !(s.id in open));
    if (missing.length) setOpen((o) => ({ ...o, ...Object.fromEntries(missing.map((s) => [s.id, true])) }));
  }, [draft.signers, open]);
  const isOpen = (k: string) => open[k] ?? true;
  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !isOpen(k) }));

  const jumpTo = (key: string) => {
    setOpen((o) => ({ ...o, [key]: true }));
    requestAnimationFrame(() =>
      scroller.current?.querySelector(`[data-section="${CSS.escape(key)}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  };

  // Box -> card: open the field's section, then scroll its card into view.
  useEffect(() => {
    if (!reveal) return;
    const f = draft.fields.find((x) => x.id === reveal.fieldId);
    if (!f) return;
    setOpen((o) => ({ ...o, [sectionOf(f)]: true }));
    const t = window.setTimeout(
      () => document.querySelector(`[data-card-id="${CSS.escape(reveal.fieldId)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }),
      60,
    );
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.nonce]);

  const onDragStart = (e: DragStartEvent) => setDragging(String(e.active.id));
  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    const target = e.over?.data.current?.target as DropTarget | undefined;
    if (!target) return;
    const id = String(e.active.id);
    if (id.startsWith("field:")) apply(moveFieldTo(id.slice(6), target));
    else if (id.startsWith("rej:")) apply(restoreRejected(id.slice(4), target));
  };

  const fields = [...draft.fields].sort(byPosition);
  const review = fields.filter(needsReview);
  const bySigner = (id: string) => fields.filter((f) => !needsReview(f) && f.signer_id === id);
  const draggedField = dragging?.startsWith("field:") ? draft.fields.find((f) => f.id === dragging.slice(6)) : undefined;
  const draggedRejected = dragging?.startsWith("rej:") ? draft.rejected.find((r) => rejectedKey(r) === dragging.slice(4)) : undefined;

  // Destinations, in board order (shared by the drop bar and the cards' "Move to…" menus).
  const destinations: (Destination & { color: string; count: number })[] = [
    { key: "review", label: "Needs review", target: { kind: "review" }, color: UNASSIGNED_COLOR, count: review.length },
    ...draft.signers.map((s) => ({
      key: s.id,
      label: (s.is_self ? "You · " : "") + (s.name?.trim() || s.label),
      target: { kind: "signer", signerId: s.id } as DropTarget,
      color: signerColor(draft.signers, s.id),
      count: bySigner(s.id).length,
    })),
    { key: "rejected", label: "Not a field", target: { kind: "rejected" }, color: REJECTED_COLOR, count: draft.rejected.length },
  ];

  const radioInfo = (f: Field): RadioInfo | undefined => {
    if (f.type !== "radio" || !f.group_id) return undefined;
    const options = radioGroup(draft.fields, f);
    const others = new Map<string, Field[]>();
    for (const x of draft.fields)
      if (x.type === "radio" && x.group_id && x.group_id !== f.group_id && x.page === f.page)
        others.set(x.group_id, [...(others.get(x.group_id) ?? []), x]);
    return {
      index: options.findIndex((o) => o.id === f.id),
      count: options.length,
      name: groupName(options),
      groups: [...others].map(([id, opts]) => ({ id, name: groupName(opts) })),
      onGroup: (g) => apply(setRadioGroup(f.id, g ?? newGroupId())),
    };
  };

  const card = (f: Field) => (
    <Draggable key={f.id} id={`field:${f.id}`}>
      <FieldCard
        field={f}
        signers={draft.signers}
        inNeedsReview={sectionOf(f) === "review"}
        selected={selectedId === f.id}
        onSelect={() => onSelect(f.id)}
        onAccept={(target) => apply(acceptField(f.id, target))}
        onType={(t) => apply(setFieldType(f.id, t))}
        onRemove={() => apply(removeField(f.id))}
        radio={radioInfo(f)}
        onValue={f.type === "signature" || f.type === "initials" ? undefined : f.type === "radio" ? () => apply(setRadioChoice(f.id)) : (v) => apply(setFieldValue(f.id, v))}
        signerName={draft.signers.find((s) => s.id === f.signer_id)?.name?.trim() || draft.signers.find((s) => s.id === f.signer_id)?.label}
        destinations={destinations.filter((d) => d.key !== sectionOf(f))}
        onMove={(t) => apply(moveFieldTo(f.id, t))}
      />
    </Draggable>
  );

  return (
    <DndContext sensors={sensors} collisionDetection={collision} autoScroll={false} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
      <div ref={scroller} className="h-full overflow-y-auto" data-testid="board">
        <DropBar items={destinations} dragging={!!dragging} onJump={jumpTo} />
        <div className="space-y-2 p-3">
          <Section sectionKey="review" target={{ kind: "review" }} title="Needs review" color={UNASSIGNED_COLOR} count={review.length}
            open={isOpen("review")} onToggle={() => toggle("review")}>
            {review.length === 0 ? (
              <p className="text-sm text-gray-600">Nothing left to review.</p>
            ) : (
              <>
                <p className="text-xs text-gray-600">Low confidence, guessed position, or no signer. Check each one.</p>
                <div className={CARD_GRID}>{review.map(card)}</div>
              </>
            )}
          </Section>

          {draft.signers.map((s) => {
            const mine = bySigner(s.id);
            return (
              <Section
                key={s.id}
                sectionKey={s.id}
                target={{ kind: "signer", signerId: s.id }}
                title={(s.is_self ? "You · " : "") + (s.name?.trim() || s.label)}
                color={signerColor(draft.signers, s.id)}
                count={mine.length}
                open={isOpen(s.id)}
                onToggle={() => toggle(s.id)}
                onTitleClick={() => onSignerHeader(s.id)}
                active={activeSignerId === s.id}
                badges={
                  <>
                    {s.role && <span className="truncate text-xs text-gray-500">{s.role}</span>}
                    {signerProblem(s) && <Badge tone="red">{problemText(s)}</Badge>}
                    {s.is_self && <Badge tone="blue">you</Badge>}
                    {!s.required && <Badge tone="gray">optional</Badge>}
                  </>
                }
                header={<SignerDetails signer={s} parties={parties} apply={apply} />}
              >
                {mine.length === 0 ? <p className="text-sm text-gray-600">No fields yet.</p> : <div className={CARD_GRID}>{mine.map(card)}</div>}
              </Section>
            );
          })}

          <button
            onClick={() => apply(addSigner())}
            className="w-full rounded border-2 border-dashed border-gray-300 py-2 text-sm text-gray-600 hover:border-gray-500"
          >
            + Add signer
          </button>

          <Section sectionKey="rejected" target={{ kind: "rejected" }} title="Not a field" color={REJECTED_COLOR} count={draft.rejected.length}
            open={isOpen("rejected")} onToggle={() => toggle("rejected")}>
            {draft.rejected.length === 0 ? (
              <p className="text-sm text-gray-600">Nothing here.</p>
            ) : (
              <>
                <p className="text-xs text-gray-600">Drag a card onto a chip (or use "Make a field for…") to turn it back into a field.</p>
                <div className={CARD_GRID}>
                  {[...draft.rejected].sort(byPosition).map((r) => (
                    <Draggable key={rejectedKey(r)} id={`rej:${rejectedKey(r)}`}>
                      <RejectedCard
                        item={r}
                        destinations={destinations.filter((d) => d.key !== "rejected")}
                        onRestore={(t) => apply(restoreRejected(rejectedKey(r), t))}
                      />
                    </Draggable>
                  ))}
                </div>
              </>
            )}
          </Section>
        </div>
      </div>
      <DragOverlay dropAnimation={null}>
        {draggedField && (
          <div className="w-64 rounded border border-blue-400 bg-white p-2 text-sm shadow-lg">
            {TYPE_ICON[draggedField.type]} {TYPE_LABEL[draggedField.type]} · {draggedField.label || "field"} · Page {draggedField.page}
          </div>
        )}
        {draggedRejected && (
          <div className="w-64 rounded border border-blue-400 bg-white p-2 text-sm shadow-lg">
            {draggedRejected.label || "Unlabelled blank"} · Page {draggedRejected.page}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
