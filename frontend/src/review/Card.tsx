import type { Field, FieldType, Rejected, Signer } from "../api";
import type { DropTarget } from "./draft";
import { confidenceWord, FIELD_TYPES, TYPE_ICON, TYPE_LABEL } from "./model";

/** For a radio option: its place in its choice, and the choices it could move to. */
export interface RadioInfo {
  index: number; // 0-based
  count: number;
  name: string;
  question: string; // the editable name of the choice ("" when it has none yet)
  onRename: (name: string) => void;
  groups: { id: string; name: string }[]; // other choices on the same page
  onGroup: (groupId: string | null) => void; // null = a new choice of its own
}

/** A place a card can be moved to (same list as the drop bar's chips). */
export interface Destination {
  key: string;
  label: string;
  target: DropTarget;
}

/** "Move to…" menu: the non-drag way to move a card. */
function MoveMenu({ placeholder, destinations, onPick }: { placeholder: string; destinations: Destination[]; onPick: (t: DropTarget) => void }) {
  return (
    <select
      data-testid="move-to"
      className="max-w-[9rem] rounded border px-1 py-0.5 text-xs"
      value=""
      onChange={(e) => {
        const d = destinations.find((x) => x.key === e.target.value);
        if (d) onPick(d.target);
      }}
    >
      <option value="" disabled>
        {placeholder}
      </option>
      {destinations.map((d) => (
        <option key={d.key} value={d.key}>
          {d.label}
        </option>
      ))}
    </select>
  );
}

export function FieldCard({
  field,
  signers,
  inNeedsReview,
  selected,
  onSelect,
  onAccept,
  onType,
  onRemove,
  destinations,
  onMove,
  radio,
  onValue,
  signerName,
}: {
  field: Field;
  signers: Signer[];
  inNeedsReview: boolean;
  selected: boolean;
  onSelect: () => void;
  onAccept: (target?: string) => void;
  onType: (t: FieldType) => void;
  onRemove: () => void;
  destinations: Destination[];
  onMove: (t: DropTarget) => void;
  radio?: RadioInfo;
  onValue?: (v: string) => void; // optional pre-fill (locked for the signer); none for signatures
  signerName?: string;
}) {
  const conf = confidenceWord(field.confidence);
  const needsSigner = field.filled_by !== "signer" || !field.signer_id;
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <div
      data-card-id={field.id}
      onClick={onSelect}
      className={`cursor-pointer rounded border bg-white p-2 text-sm shadow-sm ${
        selected ? "border-blue-500 ring-2 ring-blue-200" : "border-gray-200 hover:border-gray-400"
      }`}
    >
      <div className="flex items-center gap-1.5">
        <span className="w-4 text-center">{TYPE_ICON[field.type]}</span>
        <span className="font-medium">{TYPE_LABEL[field.type]}</span>
        <span className="ml-auto text-xs text-gray-500">Page {field.page}</span>
      </div>
      {field.label && <div className="mt-0.5 truncate text-gray-800" title={field.label}>{field.label}</div>}
      {field.description && <div className="text-xs text-gray-600">{field.description}</div>}
      {field.reason && (
        <div className="mt-1 text-xs italic text-gray-500">
          {field.placement === "user" && field.confidence === null ? field.reason : `AI: ${field.reason}`}
        </div>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs">
        {field.source === "ai" ? (
          <span className={conf.className}>{conf.word} confidence</span>
        ) : (
          <span className="text-gray-500">Checked by you</span>
        )}
        {field.placement === "label_offset" && <span className="text-amber-700">Position guessed</span>}
        {!field.required && <span className="text-gray-500">Optional</span>}
      </div>

      {radio && (
        <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-gray-700" onClick={stop} onPointerDown={stop}>
          <span>
            Option {radio.index + 1} of {radio.count}
            {radio.count === 1 && <span className="text-amber-700"> (a choice needs 2+ options)</span>}
          </span>
          <select
            data-testid="radio-group"
            className="max-w-[12rem] rounded border px-1 py-0.5 text-xs"
            value=""
            onChange={(e) => radio.onGroup(e.target.value === "__new" ? null : e.target.value)}
            title="Which choice this option belongs to"
          >
            <option value="" disabled>
              Choice: {radio.name}
            </option>
            {radio.groups.map((g) => (
              <option key={g.id} value={g.id}>
                Move to: {g.name}
              </option>
            ))}
            <option value="__new">Make it a separate choice</option>
          </select>
          <input
            data-testid="radio-name"
            value={radio.question}
            onChange={(e) => radio.onRename(e.target.value)}
            placeholder="Name this choice, e.g. Billing frequency"
            aria-label="Choice name"
            title="The question this choice answers. Renames every option of the choice."
            className="mt-1 w-full rounded border px-2 py-1 text-sm"
          />
        </div>
      )}

      {onValue && (
        <div className="mt-2 text-xs" onClick={stop} onPointerDown={stop}>
          {field.type === "radio" ? (
            <button
              data-testid="prefill-radio"
              onClick={() => onValue("true")}
              className={`w-full rounded border px-2 py-1 text-left ${field.value === "true" ? "border-blue-500 bg-blue-50 font-medium" : "text-gray-600"}`}
            >
              {field.value === "true" ? "◉ Pre-selected (click to clear)" : "○ Pre-select this option (optional)"}
            </button>
          ) : field.type === "checkbox" ? (
            <label className="flex items-center gap-1.5 text-gray-700">
              <input data-testid="prefill-check" type="checkbox" checked={field.value === "true"} onChange={(e) => onValue(e.target.checked ? "true" : "")} />
              Pre-tick it (optional)
            </label>
          ) : (
            <input
              data-testid="prefill"
              onFocus={onSelect} // show the box on the page while typing
              value={field.value ?? ""}
              onChange={(e) => onValue(e.target.value)}
              placeholder={`Pre-fill (optional)${field.type === "date" ? ", e.g. 2026-10-05" : ""}`}
              className="w-full rounded border px-2 py-1 text-sm"
            />
          )}
          {field.value && (
            <div className="mt-0.5 text-gray-500">🔒 Locked for {signerName || "the signer"} when they sign.</div>
          )}
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5" onClick={stop} onPointerDown={stop}>
        {inNeedsReview &&
          (needsSigner ? (
            <select
              className="rounded border px-1 py-0.5 text-xs"
              defaultValue=""
              onChange={(e) => e.target.value && onAccept(e.target.value)}
            >
              <option value="" disabled>
                Who does this belong to?
              </option>
              {signers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name || s.label}
                </option>
              ))}
            </select>
          ) : (
            <button className="rounded bg-green-600 px-2 py-0.5 text-xs text-white hover:bg-green-700" onClick={() => onAccept()}>
              Looks right
            </button>
          ))}
        <select
          className="rounded border px-1 py-0.5 text-xs"
          value={field.type}
          onChange={(e) => onType(e.target.value as FieldType)}
          title="Change type"
        >
          {FIELD_TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </select>
        <MoveMenu placeholder="Move to…" destinations={destinations} onPick={onMove} />
        <button className="ml-auto text-xs text-red-700 hover:underline" onClick={onRemove} title="Move to Not a field">
          Not a field
        </button>
      </div>
    </div>
  );
}

export function RejectedCard({
  item,
  destinations,
  onRestore,
}: {
  item: Rejected;
  destinations: Destination[];
  onRestore: (t: DropTarget) => void;
}) {
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <div className="rounded border border-dashed border-gray-300 bg-white p-2 text-sm text-gray-700">
      <div className="flex items-center">
        <span className="truncate">{item.label || "Unlabelled blank"}</span>
        <span className="ml-auto shrink-0 text-xs text-gray-500">Page {item.page}</span>
      </div>
      <div className="mt-1 text-xs italic text-gray-500">{item.reason}</div>
      <div className="mt-2" onClick={stop} onPointerDown={stop}>
        <MoveMenu placeholder="Make a field for…" destinations={destinations} onPick={onRestore} />
      </div>
    </div>
  );
}
