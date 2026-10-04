// Send readiness, for UX. The backend enforces the same hard rules on POST /send (send_problems in api.py);
// "needs review" and "no signature field" are UI-only (override / warn).
import type { Draft } from "../api";
import { needsReview } from "./model";

export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export interface CheckItem {
  ok: boolean;
  text: string;
  level: "block" | "review" | "warn";
}

export interface Checklist {
  items: CheckItem[];
  blocking: number; // must be fixed before Send
  reviewLeft: number; // can be overridden with "Send anyway"
}

export function checklist(d: Draft): Checklist {
  const items: CheckItem[] = [];
  const keys = new Set(d.signers.map((s) => s.id));

  items.push({ ok: d.signers.length > 0, text: "At least one signer", level: "block" });

  const unassigned = d.fields.filter((f) => f.filled_by === "signer" && !(f.signer_id && keys.has(f.signer_id)));
  items.push({
    ok: unassigned.length === 0,
    text: unassigned.length ? `${unassigned.length} field(s) have no signer` : "Every field has a signer",
    level: "block",
  });

  const noName = d.signers.filter((s) => !s.name?.trim());
  const badEmail = d.signers.filter((s) => !s.email || !EMAIL_RE.test(s.email.trim()));
  items.push({
    ok: noName.length === 0 && badEmail.length === 0,
    text:
      noName.length || badEmail.length
        ? `Enter a name and valid email for: ${[...new Set([...noName, ...badEmail].map((s) => s.label || s.id))].join(", ")}`
        : "Every signer has a name and a valid email",
    level: "block",
  });

  // Radio choices: one owner per choice. ("You" fields are filled on the document after Send.)
  const groups = new Map<string, Draft["fields"]>();
  for (const f of d.fields) if (f.type === "radio" && f.group_id) groups.set(f.group_id, [...(groups.get(f.group_id) ?? []), f]);
  const mixed = [...groups.values()].filter((g) => new Set(g.map((f) => `${f.filled_by}:${f.signer_id}`)).size > 1);
  if (mixed.length)
    items.push({ ok: false, text: `${mixed.length} choice(s) have options given to different people`, level: "block" });
  const review = d.fields.filter(needsReview).filter((f) => !(f.filled_by === "signer" && !f.signer_id));
  items.push({
    ok: review.length === 0,
    text: review.length ? `${review.length} field(s) still in Needs review` : "Nothing left to review",
    level: "review",
  });

  const noSig = d.signers.filter((s) => !d.fields.some((f) => f.signer_id === s.id && (f.type === "signature" || f.type === "initials")));
  items.push({
    ok: noSig.length === 0,
    text: noSig.length ? `No signature field for: ${noSig.map((s) => s.name || s.label).join(", ")}` : "Every signer has a signature field",
    level: "warn",
  });

  return {
    items,
    blocking: items.filter((i) => !i.ok && i.level === "block").length,
    reviewLeft: review.length,
  };
}
