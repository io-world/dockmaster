// Pure updates to the Review draft. Every edit to a field marks it source: "user" (correction data).
import type { Draft, Field, FieldType, Rejected, Signer } from "../api";

export type DraftUpdate = (d: Draft) => Draft;

export const editField = (id: string, patch: Partial<Field>): DraftUpdate => (d) => ({
  ...d,
  fields: d.fields.map((f) => (f.id === id ? { ...f, ...patch, source: "user" } : f)),
});

/** The ids of a field's radio group (all options of one choice), or just the field. */
const groupIds = (d: Draft, id: string): Set<string> => {
  const f = d.fields.find((x) => x.id === id);
  if (!f || f.type !== "radio" || !f.group_id) return new Set([id]);
  return new Set(d.fields.filter((x) => x.type === "radio" && x.group_id === f.group_id).map((x) => x.id));
};

/** Like editField, but a radio option's whole group gets the patch: one choice has one owner. */
const editGroup = (id: string, patch: Partial<Field>): DraftUpdate => (d) => {
  const ids = groupIds(d, id);
  return { ...d, fields: d.fields.map((f) => (ids.has(f.id) ? { ...f, ...patch, source: "user" } : f)) };
};

let groupSeq = 0;
export const newGroupId = () => `gu${Date.now().toString(36)}${(groupSeq++).toString(36)}`;

/** Put a radio option in another group (or a new one); it takes on that group's owner. */
export const setRadioGroup = (id: string, groupId: string): DraftUpdate => (d) => {
  const owner = d.fields.find((f) => f.type === "radio" && f.group_id === groupId && f.id !== id);
  return editField(id, {
    group_id: groupId,
    value: null,
    ...(owner ? { signer_id: owner.signer_id, filled_by: owner.filled_by } : {}),
  })(d);
};

export const SENDER_TARGET = "__sender";

/** "Looks right": the sender confirms the field, optionally choosing who fills it (a signer id or SENDER_TARGET). */
export const acceptField = (id: string, target?: string | null): DraftUpdate =>
  editGroup(
    id,
    target === undefined || target === null
      ? {}
      : target === SENDER_TARGET
        ? { filled_by: "sender", signer_id: null }
        : { filled_by: "signer", signer_id: target },
  );

export const setFieldType = (id: string, type: FieldType): DraftUpdate => (d) => {
  const f = d.fields.find((x) => x.id === id);
  if (!f || f.type === type) return d;
  // Becoming a radio starts a choice of its own (join another with the group picker); leaving one clears it.
  return editField(id, type === "radio" ? { type, group_id: newGroupId(), value: null } : { type, group_id: null, value: f.type === "radio" ? null : f.value })(d);
};

/** Move a field to "Not a field". Keeps its geometry so it can be turned back into a field. */
export const removeField = (id: string): DraftUpdate => (d) => {
  const f = d.fields.find((x) => x.id === id);
  if (!f) return d;
  const rejected: Rejected = {
    candidate_id: f.candidate_id ?? f.id,
    page: f.page,
    bbox: f.bbox,
    label: f.label,
    reason: "Removed by you",
  };
  return { ...d, fields: d.fields.filter((x) => x.id !== id), rejected: [...d.rejected, rejected] };
};

export const updateSigner = (id: string, patch: Partial<Signer>): DraftUpdate => (d) => ({
  ...d,
  signers: d.signers.map((s) => (s.id === id ? { ...s, ...patch, source: "user" } : s)),
});

/** "This is me": at most one signer is the sender. */
export const setSelf = (id: string, on: boolean): DraftUpdate => (d) => ({
  ...d,
  signers: d.signers.map((s) => ({ ...s, is_self: s.id === id ? on : on ? false : s.is_self })),
});

export const addSigner = (): DraftUpdate => (d) => {
  let n = d.signers.length + 1;
  while (d.signers.some((s) => s.id === `s${n}`)) n++;
  const signer: Signer = {
    id: `s${n}`,
    party_id: null,
    label: `Signer ${d.signers.length + 1}`,
    role: "",
    name: null,
    email: null,
    is_self: false,
    order: 1,
    required: true,
    confidence: null,
    reason: "Added by you",
    source: "user",
  };
  return { ...d, signers: [...d.signers, signer] };
};

/** Remove a signer; their fields go back to Needs review (unassigned) rather than disappearing. */
export const removeSigner = (id: string): DraftUpdate => (d) => ({
  ...d,
  signers: d.signers.filter((s) => s.id !== id),
  fields: d.fields.map((f) => (f.signer_id === id ? { ...f, signer_id: null, source: "user" } : f)),
});

export const byPosition = <T extends { page: number; bbox: number[] }>(a: T, b: T) =>
  a.page - b.page || a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0];

// ---------- step 4: drag and drop, box edits, new fields ----------

/** Where a card was dropped: Needs review, You fill, a signer column, or Not a field. */
export type DropTarget = { kind: "review" } | { kind: "sender" } | { kind: "signer"; signerId: string } | { kind: "rejected" };

export const rejectedKey = (r: Rejected) => `${r.candidate_id}@${r.page}`;

let seq = 0;
export const newFieldId = () => `u${Date.now().toString(36)}${(seq++).toString(36)}`;

/** Drop a field card on a column. */
export const moveFieldTo = (id: string, t: DropTarget): DraftUpdate => {
  if (t.kind === "rejected") return removeField(id);
  if (t.kind === "sender") return editGroup(id, { filled_by: "sender", signer_id: null });
  if (t.kind === "review") return editGroup(id, { filled_by: "signer", signer_id: null });
  return editGroup(id, { filled_by: "signer", signer_id: t.signerId });
};

/** A sensible first type from the blank's label; the sender can change it on the card. */
export function guessType(label: string): FieldType {
  const l = label.toLowerCase();
  if (/initial/.test(l)) return "initials";
  if (/sign|by:/.test(l)) return "signature";
  if (/date|dated/.test(l)) return "date";
  return "text";
}

/** Drop a "Not a field" card on a column: it becomes a field again, with its original geometry. */
export const restoreRejected = (key: string, t: DropTarget): DraftUpdate => (d) => {
  const r = d.rejected.find((x) => rejectedKey(x) === key);
  if (!r || t.kind === "rejected") return d;
  const field: Field = {
    id: newFieldId(),
    signer_id: t.kind === "signer" ? t.signerId : null,
    filled_by: t.kind === "sender" ? "sender" : "signer",
    type: guessType(r.label),
    label: r.label,
    description: "",
    page: r.page,
    bbox: r.bbox,
    required: true,
    candidate_id: r.candidate_id,
    placement: "user",
    confidence: null,
    reason: "Restored by you",
    source: "user",
    value: null,
  };
  return { ...d, fields: [...d.fields, field], rejected: d.rejected.filter((x) => rejectedKey(x) !== key) };
};

/** Box moved or resized on the page. A guessed position becomes a confirmed one. */
export const moveFieldBox = (id: string, bbox: Field["bbox"]): DraftUpdate => (d) => ({
  ...d,
  fields: d.fields.map((f) =>
    f.id === id ? { ...f, bbox, source: "user", placement: f.placement === "label_offset" ? "user" : f.placement } : f,
  ),
});

/** Default size (points) for a field dropped with "+ Add field". */
export const DEFAULT_SIZE: Record<FieldType, [number, number]> = {
  signature: [170, 26],
  initials: [50, 22],
  date: [100, 16],
  text: [170, 16],
  checkbox: [12, 12],
  radio: [12, 12],
};

export const addField = (field: Field): DraftUpdate => (d) => ({ ...d, fields: [...d.fields, field] });

/** "Reset to AI suggestions": fields and "Not a field" go back to the AI's proposal (who fills what, types, boxes;
 * removed fields return, added ones go). Signers go back to the AI's list but keep the name, email and "this is me"
 * the sender typed, and "You fill" values are kept for fields that are still "You fill". */
export const resetToAi = (ai: Draft): DraftUpdate => (d) => {
  const signers = new Map(d.signers.map((s) => [s.id, s]));
  const values = new Map(d.fields.map((f) => [f.id, f.value]));
  return {
    signers: ai.signers.map((s) => {
      const cur = signers.get(s.id);
      return cur ? { ...s, name: cur.name, email: cur.email, is_self: cur.is_self } : s;
    }),
    fields: ai.fields.map((f) => (f.filled_by === "sender" ? { ...f, value: values.get(f.id) ?? f.value } : f)),
    rejected: ai.rejected,
  };
};
