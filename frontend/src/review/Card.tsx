import type { Field, FieldType, Rejected, Signer } from "../api";
import { SENDER_TARGET } from "./draft";
import { confidenceWord, TYPE_ICON, TYPE_LABEL } from "./model";

const TYPES: FieldType[] = ["signature", "initials", "date", "text", "checkbox"];

export function FieldCard({
  field,
  signers,
  inNeedsReview,
  selected,
  onSelect,
  onAccept,
  onType,
  onRemove,
  onValue,
}: {
  field: Field;
  signers: Signer[];
  inNeedsReview: boolean;
  selected: boolean;
  onSelect: () => void;
  onAccept: (target?: string) => void;
  onType: (t: FieldType) => void;
  onRemove: () => void;
  onValue?: (v: string) => void; // "You fill" fields
}) {
  const conf = confidenceWord(field.confidence);
  const needsSigner = field.filled_by === "signer" && !field.signer_id;
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

      {onValue && (
        <input
          onClick={stop}
          onPointerDown={stop}
          value={field.value ?? ""}
          onChange={(e) => onValue(e.target.value)}
          placeholder={field.type === "date" ? "e.g. 2026-10-02" : "Type the value"}
          className="mt-2 w-full rounded border px-2 py-1 text-sm"
        />
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
                Looks right: who fills it?
              </option>
              {signers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name || s.label}
                </option>
              ))}
              <option value={SENDER_TARGET}>Me, before sending</option>
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
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </select>
        <button className="ml-auto text-xs text-red-700 hover:underline" onClick={onRemove} title="Move to Not a field">
          Not a field
        </button>
      </div>
    </div>
  );
}

export function RejectedCard({ item }: { item: Rejected }) {
  return (
    <div className="rounded border border-dashed border-gray-300 bg-white p-2 text-sm text-gray-700">
      <div className="flex items-center">
        <span className="truncate">{item.label || "Unlabelled blank"}</span>
        <span className="ml-auto shrink-0 text-xs text-gray-500">Page {item.page}</span>
      </div>
      <div className="mt-1 text-xs italic text-gray-500">{item.reason}</div>
    </div>
  );
}
