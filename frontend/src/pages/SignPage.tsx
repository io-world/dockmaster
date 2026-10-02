// Public signing page (/sign/:token). No account: the link token is the credential.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type Field, type SigningView } from "../api";
import PdfPreview, { type PreviewBox } from "../components/PdfPreview";
import SignatureModal from "../components/SignatureModal";
import { ErrorBox, Spinner } from "../components/ui";
import { bboxToPx } from "../geometry";
import { TYPE_LABEL } from "../review/model";

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const byPos = (a: Field, b: Field) => a.page - b.page || a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0];
const isFilled = (f: Field, v: string | undefined) => (f.type === "checkbox" ? true : !!(v ?? "").trim());

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="border-b bg-white">
        <div className="mx-auto flex h-12 max-w-5xl items-center px-4 font-semibold">DockMaster</div>
      </header>
      <main className="mx-auto max-w-5xl p-4">{children}</main>
    </div>
  );
}

export default function SignPage({ token }: { token: string }) {
  const [view, setView] = useState<SigningView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [signing, setSigning] = useState<Field | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<{ message: string; problems: string[] } | null>(null);
  const [done, setDone] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    setError(null);
    api
      .getSigning(token)
      .then((v) => {
        setView(v);
        const init: Record<string, string> = {};
        for (const f of v.fields) {
          if (f.value) init[f.id] = f.value;
          else if (f.type === "date") init[f.id] = today(); // prefilled, editable
          else if (f.type === "checkbox") init[f.id] = "false";
        }
        setValues(init);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Couldn't open this signing link."));
  }, [token]);
  useEffect(load, [load]);

  const mine = useMemo(() => (view ? [...view.fields].sort(byPos) : []), [view]);
  const left = mine.filter((f) => f.required && !isFilled(f, values[f.id]));
  const setValue = (id: string, v: string) => setValues((cur) => ({ ...cur, [id]: v }));

  const goTo = (f: Field) => {
    setActive(f.id);
    const el = scroller.current?.querySelector(`[data-box-id="${CSS.escape(f.id)}"]`) as HTMLElement | null;
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => (el?.querySelector("input") as HTMLInputElement | null)?.focus({ preventScroll: true }), 400);
  };

  const submit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await api.submitSigning(token, Object.fromEntries(mine.map((f) => [f.id, values[f.id] ?? null])));
      setDone(true);
      load();
    } catch (e) {
      setSubmitError(e instanceof ApiError ? { message: e.message, problems: e.problems } : { message: "Couldn't submit. Please try again.", problems: [] });
    } finally {
      setSubmitting(false);
    }
  };

  if (error)
    return (
      <Shell>
        <ErrorBox message={error} onRetry={load} />
      </Shell>
    );
  if (!view)
    return (
      <Shell>
        <Spinner label="Opening document…" />
      </Shell>
    );

  const download = view.final_pdf_url && (
    <a href={view.final_pdf_url} className="inline-block rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white" data-testid="download">
      Download the signed PDF
    </a>
  );

  // Already signed (just now, or opened again later).
  if (done || view.signer.status === "signed")
    return (
      <Shell>
        <div className="space-y-3 rounded border bg-white p-6" data-testid="signed-confirmation">
          <h1 className="text-lg font-semibold">✓ You've signed {view.envelope.filename}</h1>
          {view.envelope.status === "completed" ? (
            <>
              <p className="text-gray-700">Everyone has signed. The completed document is ready.</p>
              {download}
            </>
          ) : (
            <p className="text-gray-700">
              We'll let {view.envelope.sender_email ?? "the sender"} know. The completed PDF will be available here once everyone has signed.
            </p>
          )}
        </div>
      </Shell>
    );

  if (view.waiting_for_others)
    return (
      <Shell>
        <div className="rounded border bg-white p-6">
          <h1 className="font-semibold">Not your turn yet</h1>
          <p className="text-gray-700">Other people need to sign {view.envelope.filename} first. You'll get a new link when it's your turn.</p>
        </div>
      </Shell>
    );

  const boxes: PreviewBox[] = [
    ...mine.map((f) => ({ id: f.id, page: f.page, bbox: f.bbox, color: "#2563eb" })),
    ...view.others.map((o, i) => ({ id: `other-${i}`, page: o.page, bbox: o.bbox, color: "#94a3b8", muted: true })),
    ...view.prefilled.map((p, i) => ({ id: `pre-${i}`, page: p.page, bbox: p.bbox, color: "#475569" })),
  ];
  const fieldById = new Map(mine.map((f) => [f.id, f]));

  const renderBox = (b: PreviewBox, scale: number) => {
    const r = bboxToPx(b.bbox, scale);
    const pos = { left: r.left, top: r.top, width: r.width, height: r.height };
    if (b.id.startsWith("other-"))
      return <div key={b.id} title="Another signer's field" className="absolute rounded-sm bg-slate-300/40" style={pos} />;
    if (b.id.startsWith("pre-")) {
      const p = view.prefilled[Number(b.id.slice(4))];
      return (
        <div key={b.id} className="absolute flex items-end overflow-hidden whitespace-nowrap px-0.5 text-[#0b2a6f]" style={{ ...pos, fontSize: Math.max(8, Math.min(r.height * 0.75, 14)) }}>
          {p.value}
        </div>
      );
    }
    const f = fieldById.get(b.id)!;
    const v = values[f.id] ?? "";
    const filled = isFilled(f, v);
    const ring = active === f.id ? "ring-2 ring-blue-400" : "";
    const border = filled ? "border-green-600 bg-green-50/40" : f.required ? "border-amber-500 bg-amber-50/70" : "border-blue-400 bg-blue-50/50";
    const fontSize = Math.max(8, Math.min(r.height * 0.7, 14));
    return (
      <div key={b.id} data-box-id={f.id} className={`absolute rounded-sm border-2 ${border} ${ring}`} style={pos} onClick={() => setActive(f.id)}>
        {(f.type === "signature" || f.type === "initials") &&
          (v ? (
            <button className="h-full w-full" onClick={() => setSigning(f)} title="Change">
              <img src={v} alt="Your signature" className="h-full w-full object-contain object-left" />
            </button>
          ) : (
            <button className="h-full w-full text-left font-medium text-amber-800" style={{ fontSize }} onClick={() => setSigning(f)}>
              {f.type === "initials" ? "Initial here" : "Sign here"}
            </button>
          ))}
        {(f.type === "text" || f.type === "date") && (
          <input
            type={f.type === "date" ? "date" : "text"}
            value={v}
            onChange={(e) => setValue(f.id, e.target.value)}
            onFocus={() => setActive(f.id)}
            placeholder={f.label || TYPE_LABEL[f.type]}
            aria-label={f.label || TYPE_LABEL[f.type]}
            className="h-full w-full bg-transparent px-0.5 outline-none"
            style={{ fontSize }}
          />
        )}
        {f.type === "checkbox" && (
          <input
            type="checkbox"
            checked={v === "true"}
            onChange={(e) => setValue(f.id, e.target.checked ? "true" : "false")}
            aria-label={f.label || "Checkbox"}
            className="h-full w-full"
          />
        )}
      </div>
    );
  };

  return (
    <div className="flex h-screen flex-col">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-4 py-2">
          <span className="font-semibold">DockMaster</span>
          <div className="min-w-0 flex-1 text-sm">
            <div className="truncate">
              <span className="font-medium">{view.envelope.sender_email ?? "Someone"}</span> asked you
              {view.signer.name ? ` (${view.signer.name})` : ""} to sign <span className="font-medium">{view.envelope.filename}</span>.
            </div>
            <div className="text-gray-600">Fill in the highlighted fields, then click Finish.</div>
          </div>
          <span className="text-sm text-gray-700" data-testid="fields-left">
            {left.length === 0 ? "All required fields done" : `${left.length} field${left.length === 1 ? "" : "s"} left`}
          </span>
          <button
            data-testid="next-field"
            onClick={() => left[0] && goTo(left[0])}
            disabled={left.length === 0}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm disabled:opacity-50"
          >
            Next field
          </button>
          <button
            data-testid="finish"
            onClick={submit}
            disabled={left.length > 0 || submitting}
            title={left.length ? "Fill in all required fields first" : undefined}
            className="rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {submitting ? "Submitting…" : "Finish"}
          </button>
        </div>
        {submitError && (
          <div className="mx-auto max-w-5xl px-4 pb-2">
            <ErrorBox message={submitError.message} problems={submitError.problems} />
          </div>
        )}
      </header>
      <div ref={scroller} className="flex-1 overflow-y-auto bg-gray-100 p-4">
        <div className="mx-auto max-w-3xl">
          {mine.length === 0 && <p className="mb-3 text-sm text-gray-600">There are no fields for you in this document.</p>}
          <PdfPreview pages={view.pages} boxes={boxes} renderBox={renderBox} />
        </div>
      </div>
      {signing && (
        <SignatureModal
          kind={signing.type === "initials" ? "initials" : "signature"}
          defaultName={view.signer.name ?? ""}
          onCancel={() => setSigning(null)}
          onDone={(png) => {
            setValue(signing.id, png);
            setSigning(null);
          }}
        />
      )}
    </div>
  );
}
