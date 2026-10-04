// Presentation logic for the Review screen: which fields need review, colors, labels. No business rules here;
// the backend enforces what can be sent.
import type { Field, FieldType, Signer } from "../api";

export const NEEDS_REVIEW_THRESHOLD = 0.7;

export function needsReview(f: Field): boolean {
  if (f.filled_by === "signer" && !f.signer_id) return true; // always: someone has to fill it
  if (f.source === "user") return false; // the sender has checked or edited it
  return f.placement === "label_offset" || (f.confidence ?? 0) < NEEDS_REVIEW_THRESHOLD;
}

// Distinct, readable outline colors. Sender ("You fill") fields use SENDER_COLOR; unassigned use UNASSIGNED_COLOR.
const PALETTE = ["#2563eb", "#ea580c", "#16a34a", "#9333ea", "#db2777", "#0891b2", "#ca8a04", "#4f46e5"];
export const SENDER_COLOR = "#475569";
export const UNASSIGNED_COLOR = "#dc2626";

/** Stable per signer: derived from the id ("s3" -> 3rd color), so removing a signer never recolors the others. */
export function signerColor(signers: Signer[], signerId: string | null): string {
  if (!signerId || !signers.some((s) => s.id === signerId)) return UNASSIGNED_COLOR;
  const n = Number(signerId.replace(/\D/g, ""));
  const i = Number.isFinite(n) && n > 0 ? n - 1 : [...signerId].reduce((a, c) => a + c.charCodeAt(0), 0);
  return PALETTE[i % PALETTE.length];
}

export function fieldColor(f: Field, signers: Signer[]): string {
  return f.filled_by === "sender" ? SENDER_COLOR : signerColor(signers, f.signer_id);
}

export const FIELD_TYPES: FieldType[] = ["signature", "initials", "date", "text", "checkbox", "radio"];

export const TYPE_LABEL: Record<FieldType, string> = {
  signature: "Signature",
  initials: "Initials",
  date: "Date",
  text: "Text",
  checkbox: "Checkbox",
  radio: "Radio option",
};

export const TYPE_ICON: Record<FieldType, string> = {
  signature: "✍",
  initials: "✎",
  date: "📅",
  text: "T",
  checkbox: "☑",
  radio: "◉",
};

/** The options of a field's radio group, in reading order (just the field itself if it isn't a radio). */
export function radioGroup(fields: Field[], f: Field): Field[] {
  if (f.type !== "radio" || !f.group_id) return [f];
  return fields
    .filter((x) => x.type === "radio" && x.group_id === f.group_id)
    .sort((a, b) => a.page - b.page || a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
}

/** A short name for a radio group: its question, or its options. */
export function groupName(options: Field[]): string {
  const q = options.find((o) => o.description)?.description;
  if (q) return q;
  const labels = options.map((o) => o.label).filter(Boolean);
  return labels.length ? labels.join(" / ") : "Unnamed choice";
}

/** Short tag for a signer: name initial once a name is entered, otherwise its number (1, 2, …). */
export function signerTag(signers: Signer[], f: Field): string {
  if (f.filled_by === "sender") return "You";
  const i = signers.findIndex((x) => x.id === f.signer_id);
  if (i < 0) return "?";
  const name = signers[i].name?.trim();
  return name ? name.charAt(0).toUpperCase() : String(i + 1);
}

/** Compact box tag, e.g. "✍ 1": small enough not to cover the document's own labels. */
export function boxTag(signers: Signer[], f: Field): string {
  return `${TYPE_ICON[f.type]} ${signerTag(signers, f)}`;
}

export function confidenceWord(c: number | null): { word: "High" | "Medium" | "Low"; className: string } {
  const v = c ?? 0;
  if (v >= 0.85) return { word: "High", className: "text-green-700" };
  if (v >= NEEDS_REVIEW_THRESHOLD) return { word: "Medium", className: "text-amber-700" };
  return { word: "Low", className: "text-red-700" };
}
