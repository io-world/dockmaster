import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { useState, type ReactNode } from "react";
import type { Draft, Field, Party, Signer } from "../api";
import { FieldCard, RejectedCard } from "./Card";
import {
  acceptField,
  addSigner,
  byPosition,
  moveFieldTo,
  rejectedKey,
  removeField,
  removeSigner,
  restoreRejected,
  setFieldType,
  setFieldValue,
  setSelf,
  updateSigner,
  type DraftUpdate,
  type DropTarget,
} from "./draft";
import { needsReview, SENDER_COLOR, signerColor, TYPE_ICON, TYPE_LABEL, UNASSIGNED_COLOR } from "./model";

const targetId = (t: DropTarget) => (t.kind === "signer" ? `col:${t.signerId}` : `col:${t.kind}`);

/** Makes its children draggable as a whole card. */
function Draggable({ id, children }: { id: string; children: ReactNode }) {
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({ id });
  return (
    <div ref={setNodeRef} {...listeners} {...attributes} className={isDragging ? "opacity-30" : ""}>
      {children}
    </div>
  );
}

/** Drop zone wrapper: highlights while a card is over it. */
function Droppable({ target, children, className }: { target: DropTarget; children: ReactNode; className?: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: targetId(target), data: { target } });
  return (
    <div ref={setNodeRef} className={`${className ?? ""} ${isOver ? "ring-2 ring-blue-400" : ""}`}>
      {children}
    </div>
  );
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function Column({
  target,
  title,
  color,
  count,
  header,
  onHeaderClick,
  active,
  children,
  testId,
}: {
  target: DropTarget;
  title: string;
  color: string;
  count: number;
  header?: ReactNode;
  onHeaderClick?: () => void;
  active?: boolean;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <Droppable target={target} className="flex h-full w-64 shrink-0 flex-col rounded bg-gray-100">
      <div data-testid={testId} className="contents">
      <div
        onClick={onHeaderClick}
        className={`border-t-4 p-2 ${onHeaderClick ? "cursor-pointer" : ""} ${active ? "bg-blue-50" : ""}`}
        style={{ borderTopColor: color }}
        title={onHeaderClick ? "Click to highlight these fields on the document" : undefined}
      >
        <div className="flex items-center gap-2">
          <span className="font-medium">{title}</span>
          <span className="ml-auto rounded bg-white px-1.5 text-xs text-gray-600">{count}</span>
        </div>
        {header}
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">{children}</div>
      </div>
    </Droppable>
  );
}

function SignerHeader({ signer, parties, apply }: { signer: Signer; parties: Party[]; apply: (u: DraftUpdate) => void }) {
  const party = parties.find((p) => p.id === signer.party_id);
  const role = signer.role || party?.role;
  const emailBad = !!signer.email && !EMAIL_RE.test(signer.email);
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <div className="mt-1 space-y-1.5 text-sm" onClick={stop} onPointerDown={stop}>
      {(role || party?.name) && (
        <div className="text-xs text-gray-600">
          {role}
          {party?.name ? ` · ${party.name}` : ""}
        </div>
      )}
      <input
        value={signer.name ?? ""}
        onChange={(e) => apply(updateSigner(signer.id, { name: e.target.value }))}
        placeholder="Full name"
        className="w-full rounded border px-2 py-1"
      />
      <input
        value={signer.email ?? ""}
        onChange={(e) => apply(updateSigner(signer.id, { email: e.target.value }))}
        placeholder="Email"
        type="email"
        className={`w-full rounded border px-2 py-1 ${emailBad ? "border-red-400" : ""}`}
      />
      {emailBad && <div className="text-xs text-red-700">Enter a valid email</div>}
      <div className="flex items-center gap-3 text-xs">
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={signer.is_self} onChange={(e) => apply(setSelf(signer.id, e.target.checked))} />
          This is me
        </label>
        {!signer.required && <span className="text-gray-500">Optional signer</span>}
        <button
          className="ml-auto text-gray-500 hover:text-red-700 hover:underline"
          onClick={() => apply(removeSigner(signer.id))}
          title="Remove this signer; their fields go back to Needs review"
        >
          Remove
        </button>
      </div>
    </div>
  );
}

export default function Board({
  draft,
  parties,
  apply,
  selectedId,
  onSelect,
  activeSignerId,
  onSignerHeader,
}: {
  draft: Draft;
  parties: Party[];
  apply: (u: DraftUpdate) => void;
  selectedId: string | null;
  onSelect: (fieldId: string) => void;
  activeSignerId: string | null;
  onSignerHeader: (signerId: string) => void;
}) {
  const [showRejected, setShowRejected] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const onDragStart = (e: DragStartEvent) => setDragging(String(e.active.id));
  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    const target = e.over?.data.current?.target as DropTarget | undefined;
    if (!target) return;
    const id = String(e.active.id);
    if (id.startsWith("field:")) apply(moveFieldTo(id.slice(6), target));
    else if (id.startsWith("rej:")) apply(restoreRejected(id.slice(4), target));
  };
  const draggedField = dragging?.startsWith("field:") ? draft.fields.find((f) => f.id === dragging.slice(6)) : undefined;
  const draggedRejected = dragging?.startsWith("rej:") ? draft.rejected.find((r) => rejectedKey(r) === dragging.slice(4)) : undefined;
  const fields = [...draft.fields].sort(byPosition);
  const review = fields.filter(needsReview);
  const sender = fields.filter((f) => f.filled_by === "sender" && !needsReview(f));

  const card = (f: Field, inNeedsReview: boolean) => (
    <Draggable key={f.id} id={`field:${f.id}`}>
    <FieldCard
      key={f.id}
      field={f}
      signers={draft.signers}
      inNeedsReview={inNeedsReview}
      selected={selectedId === f.id}
      onSelect={() => onSelect(f.id)}
      onAccept={(target) => apply(acceptField(f.id, target))}
      onType={(t) => apply(setFieldType(f.id, t))}
      onRemove={() => apply(removeField(f.id))}
      onValue={f.filled_by === "sender" ? (v) => apply(setFieldValue(f.id, v)) : undefined}
    />
    </Draggable>
  );

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
    <div className="flex h-full gap-3 overflow-x-auto p-3" data-testid="board">
      <Column target={{ kind: "review" }} title="Needs review" color={UNASSIGNED_COLOR} count={review.length} testId="col-review">
        {review.length === 0 ? (
          <p className="p-2 text-sm text-gray-600">Nothing left to review.</p>
        ) : (
          <>
            <p className="px-1 text-xs text-gray-600">Low confidence, guessed position, or no signer. Check each one.</p>
            {review.map((f) => card(f, true))}
          </>
        )}
      </Column>

      {(sender.length > 0 || draft.fields.some((f) => f.filled_by === "sender") || dragging) && (
        <Column target={{ kind: "sender" }} title="You fill before sending" color={SENDER_COLOR} count={sender.length} testId="col-sender">
          <p className="px-1 text-xs text-gray-600">Values you complete now (e.g. amounts, dates, names in the text).</p>
          {sender.map((f) => card(f, false))}
        </Column>
      )}

      {draft.signers.map((s) => {
        const mine = fields.filter((f) => f.signer_id === s.id && f.filled_by === "signer" && !needsReview(f));
        return (
          <Column
            key={s.id}
            target={{ kind: "signer", signerId: s.id }}
            testId={`col-${s.id}`}
            title={s.name || s.label}
            color={signerColor(draft.signers, s.id)}
            count={mine.length}
            active={activeSignerId === s.id}
            onHeaderClick={() => onSignerHeader(s.id)}
            header={<SignerHeader signer={s} parties={parties} apply={apply} />}
          >
            {mine.length === 0 ? <p className="p-2 text-sm text-gray-600">No fields yet.</p> : mine.map((f) => card(f, false))}
          </Column>
        );
      })}

      <button
        onClick={() => apply(addSigner())}
        className="h-10 w-40 shrink-0 rounded border-2 border-dashed border-gray-300 text-sm text-gray-600 hover:border-gray-500"
      >
        + Add signer
      </button>

      {showRejected ? (
        <Column target={{ kind: "rejected" }} title="Not a field" color="#9ca3af" count={draft.rejected.length} testId="col-rejected"
          header={<button className="text-xs underline" onClick={() => setShowRejected(false)}>Collapse</button>}>
          {draft.rejected.length === 0 ? (
            <p className="p-2 text-sm text-gray-600">Nothing here.</p>
          ) : (
            <>
              <p className="px-1 text-xs text-gray-600">Drag a card onto a column to make it a field.</p>
              {[...draft.rejected].sort(byPosition).map((r) => (
                <Draggable key={rejectedKey(r)} id={`rej:${rejectedKey(r)}`}>
                  <RejectedCard item={r} />
                </Draggable>
              ))}
            </>
          )}
        </Column>
      ) : (
        <Droppable target={{ kind: "rejected" }} className="h-10 w-40 shrink-0 rounded">
          <button
            data-testid="rejected-toggle"
            onClick={() => setShowRejected(true)}
            className="h-10 w-40 rounded bg-gray-100 text-sm text-gray-700 hover:bg-gray-200"
          >
            Not a field ({draft.rejected.length})
          </button>
        </Droppable>
      )}
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
