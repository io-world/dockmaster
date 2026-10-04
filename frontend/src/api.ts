// The only module that talks to the backend. Components never call fetch directly.
// Shapes mirror backend/app/api.py (the source of truth). All bboxes are PDF points, origin top-left.

export type FieldType = "signature" | "initials" | "date" | "text" | "checkbox" | "radio";
export type EnvelopeStatus = "draft" | "sent" | "completed";
export type BBox = [number, number, number, number];

export interface User {
  id: number;
  email: string;
}

export interface EnvelopeSummary {
  id: number;
  filename: string;
  status: EnvelopeStatus;
  created_at: string;
  signed_count: number;
  signer_count: number;
}

export interface Page {
  n: number;
  width: number;
  height: number;
  rotation: number;
  text_layer: boolean;
  image_url: string;
}

export interface Party {
  id: string;
  name: string | null;
  role: string;
  evidence: string;
}

export interface Signer {
  id: string;
  party_id: string | null;
  label: string;
  role: string;
  name: string | null;
  email: string | null;
  is_self: boolean;
  order: number;
  required: boolean;
  confidence: number | null;
  reason: string;
  source: "ai" | "user";
  status?: "pending" | "notified" | "signed";
  signed_at?: string | null;
}

export interface Field {
  id: string;
  signer_id: string | null;
  filled_by: "signer" | "sender";
  type: FieldType;
  group_id?: string | null; // radio only: options of one choice share it; exactly one is picked
  label: string;
  description: string;
  page: number;
  bbox: BBox;
  required: boolean;
  candidate_id: string | null;
  placement: string; // widget | line | underscore | label_offset | checkbox | user
  confidence: number | null;
  reason: string;
  source: "ai" | "user";
  value: string | null; // checkbox/radio: "true" | "false"
}

export interface Rejected {
  candidate_id: string;
  page: number;
  bbox: BBox;
  label: string;
  reason: string;
}

export interface MissingField {
  page: number;
  signer_id: string | null;
  type: FieldType;
  description: string;
}

export interface EnvelopeDetail {
  id: number;
  filename: string;
  status: EnvelopeStatus;
  created_at: string;
  sent_at: string | null;
  completed_at: string | null;
  doc_type: string | null;
  summary: string | null;
  pages: Page[];
  parties: Party[];
  signers: Signer[];
  fields: Field[];
  rejected: Rejected[];
  ai_draft: Draft | null; // the AI's untouched proposal (null for older envelopes)
  missing_fields: MissingField[];
  warnings: string[];
  ai: { ok: boolean; model: string | null; cost_usd: number | null; duration_ms: number | null };
  signed_count: number;
  signer_count: number;
}

export interface Draft {
  signers: Signer[];
  fields: Field[];
  rejected: Rejected[];
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AskResult {
  answer: string;
  meta: { model: string; cost_usd: number; duration_ms: number };
}

export interface SendResult {
  status: EnvelopeStatus;
  self_sign_token: string | null;
}

export interface OutboxEntry {
  id: number;
  envelope_id: number;
  to: string;
  subject: string;
  body: string;
  event: "sent" | "your_turn" | "signed" | "completed";
  link: string | null;
  created_at: string;
  can_resend: boolean; // newest "your turn" for someone who still has to sign: email can be edited and resent
  link_replaced: boolean; // the email was changed since: this old link no longer works
}

export interface StatusSigner {
  id: string;
  label: string;
  role: string;
  name: string | null;
  email: string | null;
  is_self: boolean;
  order: number;
  status: "pending" | "notified" | "signed";
  signed_at: string | null;
  sign_url: string | null;
}

export interface EnvelopeStatusView {
  id: number;
  filename: string;
  status: EnvelopeStatus;
  sent_at: string | null;
  completed_at: string | null;
  signed_count: number;
  signer_count: number;
  final_pdf_url: string | null;
  signers: StatusSigner[];
  outbox: OutboxEntry[];
}

export interface SigningView {
  envelope: { filename: string; doc_type: string | null; status: EnvelopeStatus; sender_email: string | null };
  signer: {
    id: string;
    label: string;
    name: string | null;
    email: string | null;
    status: string;
    signed_at: string | null;
    is_self: boolean; // the sender: fills their part first, then the others are notified
    envelope_id: number | null; // only for the sender (link back to the Status page)
  };
  can_sign: boolean;
  waiting_for_others: boolean;
  others_wait_for_me: boolean;
  pages: Page[];
  fields: Field[];
  others: { page: number; bbox: BBox; type: FieldType }[];
  prefilled: { page: number; bbox: BBox; type: FieldType; value: string }[];
  final_pdf_url: string | null;
}

// ---------- transport ----------

export class ApiError extends Error {
  status: number;
  problems: string[];
  constructor(status: number, message: string, problems: string[] = []) {
    super(message);
    this.status = status;
    this.problems = problems;
  }
}

let onUnauthorized: () => void = () => {};
/** The auth context registers a handler so any 401 sends the user back to sign-in. */
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

async function request<T>(method: string, path: string, body?: unknown, opts: { auth?: boolean } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body !== undefined && !(body instanceof FormData) ? { "Content-Type": "application/json" } : undefined,
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Can't reach the server. Check your connection and that the backend is running.");
  }
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    let problems: string[] = [];
    try {
      const data = await res.json();
      const d = data?.detail;
      if (typeof d === "string") message = d;
      else if (d && typeof d === "object") {
        message = d.message ?? message;
        problems = Array.isArray(d.problems) ? d.problems : [];
      }
    } catch {
      /* non-JSON error body: keep the generic message */
    }
    if (res.status === 401 && opts.auth !== false) onUnauthorized();
    throw new ApiError(res.status, message, problems);
  }
  return (await res.json()) as T;
}

// ---------- auth ----------

export const api = {
  me: () => request<User>("GET", "/api/auth/me", undefined, { auth: false }),
  signup: (email: string, password: string) =>
    request<User>("POST", "/api/auth/signup", { email, password }, { auth: false }),
  login: (email: string, password: string) =>
    request<User>("POST", "/api/auth/login", { email, password }, { auth: false }),
  logout: () => request<{ ok: boolean }>("POST", "/api/auth/logout", undefined, { auth: false }),

  // ---------- envelopes ----------
  listEnvelopes: () => request<EnvelopeSummary[]>("GET", "/api/envelopes"),
  uploadEnvelope: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<EnvelopeDetail>("POST", "/api/envelopes", form);
  },
  getEnvelope: (id: number) => request<EnvelopeDetail>("GET", `/api/envelopes/${id}`),
  deleteEnvelope: (id: number) => request<{ ok: boolean }>("DELETE", `/api/envelopes/${id}`),
  saveDraft: (id: number, draft: Draft) => request<EnvelopeDetail>("PUT", `/api/envelopes/${id}`, draft),
  send: (id: number) => request<SendResult>("POST", `/api/envelopes/${id}/send`),
  getStatus: (id: number) => request<EnvelopeStatusView>("GET", `/api/envelopes/${id}/status`),
  outbox: () => request<OutboxEntry[]>("GET", "/api/outbox"),
  resendLink: (entryId: number, email: string) =>
    request<{ ok: boolean; changed: boolean }>("POST", `/api/outbox/${entryId}/resend`, { email }),
  askEnvelope: (id: number, question: string, history: ChatMessage[]) =>
    request<AskResult>("POST", `/api/envelopes/${id}/ask`, { question, history }),

  // ---------- signing (no login; token is the credential) ----------
  getSigning: (token: string) => request<SigningView>("GET", `/api/sign/${token}`, undefined, { auth: false }),
  askSigning: (token: string, question: string, history: ChatMessage[]) =>
    request<AskResult>("POST", `/api/sign/${token}/ask`, { question, history }, { auth: false }),
  submitSigning: (token: string, values: Record<string, string | null>) =>
    request<{ status: string; envelope_status: EnvelopeStatus }>("POST", `/api/sign/${token}`, { values }, { auth: false }),
};
