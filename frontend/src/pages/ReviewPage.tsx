import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type Draft, type EnvelopeDetail, type FieldType } from "../api";
import Layout from "../components/Layout";
import PdfPreview, { type PageClick, type PreviewBox } from "../components/PdfPreview";
import { ErrorBox, Spinner } from "../components/ui";
import Board from "../review/Board";
import { checklist, type Checklist } from "../review/checklist";
import { addField, DEFAULT_SIZE, moveFieldBox, newFieldId, SENDER_TARGET, type DraftUpdate } from "../review/draft";
import { boxTag, fieldColor, needsReview, TYPE_LABEL } from "../review/model";

const TYPES: FieldType[] = ["signature", "initials", "date", "text", "checkbox"];

type SaveState = "saved" | "dirty" | "saving" | "error";

function SaveStatus({ state, error, onRetry }: { state: SaveState; error: string | null; onRetry: () => void }) {
  if (state === "error")
    return (
      <span className="text-xs text-red-700" data-testid="save-status">
        Couldn't save{error ? `: ${error}` : ""}.{" "}
        <button className="underline" onClick={onRetry}>
          Retry
        </button>
      </span>
    );
  const text = { saved: "All changes saved", dirty: "Unsaved changes…", saving: "Saving…" }[state];
  return (
    <span className={`text-xs ${state === "saved" ? "text-green-700" : "text-gray-500"}`} data-testid="save-status">
      {text}
    </span>
  );
}

function ChecklistPanel({ list }: { list: Checklist }) {
  const icon = (ok: boolean, level: string) => (ok ? "✓" : level === "warn" ? "⚠" : level === "review" ? "•" : "✗");
  const color = (ok: boolean, level: string) =>
    ok ? "text-green-700" : level === "warn" ? "text-amber-700" : level === "review" ? "text-amber-700" : "text-red-700";
  return (
    <div data-testid="checklist" className="absolute right-0 top-full z-40 mt-1 w-96 rounded border bg-white p-3 text-sm shadow-lg">
      <div className="mb-1 font-medium">Before sending</div>
      <ul className="space-y-1">
        {list.items.map((i) => (
          <li key={i.text} className={`flex gap-2 ${color(i.ok, i.level)}`}>
            <span className="w-4 shrink-0 text-center">{icon(i.ok, i.level)}</span>
            <span>
              {i.text}
              {!i.ok && i.level === "review" && <span className="text-gray-500"> (you can send anyway)</span>}
              {!i.ok && i.level === "warn" && <span className="text-gray-500"> (warning only)</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ConfirmDialog({ text, confirm, onConfirm, onCancel }: { text: string; confirm: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="w-96 space-y-3 rounded bg-white p-4 shadow-xl" role="dialog">
        <p className="text-sm">{text}</p>
        <div className="flex justify-end gap-2">
          <button className="rounded border px-3 py-1.5 text-sm" onClick={onCancel}>
            Go back
          </button>
          <button className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white" onClick={onConfirm}>
            {confirm}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Popover after clicking the page in "+ Add field" mode: pick type and who fills it. */
function AddFieldPopover({
  at,
  signers,
  onAdd,
  onCancel,
}: {
  at: PageClick;
  signers: Draft["signers"];
  onAdd: (type: FieldType, target: string) => void;
  onCancel: () => void;
}) {
  const [type, setType] = useState<FieldType>("signature");
  const [target, setTarget] = useState(signers[0]?.id ?? SENDER_TARGET);
  const left = Math.min(at.clientX + 8, window.innerWidth - 260);
  const top = Math.min(at.clientY + 8, window.innerHeight - 170);
  return (
    <div data-testid="add-popover" className="fixed z-50 w-60 space-y-2 rounded border bg-white p-3 text-sm shadow-lg" style={{ left, top }}>
      <div className="font-medium">New field on page {at.page}</div>
      <label className="block">
        Type
        <select value={type} onChange={(e) => setType(e.target.value as FieldType)} className="mt-0.5 w-full rounded border px-1 py-1">
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        Who fills it
        <select value={target} onChange={(e) => setTarget(e.target.value)} className="mt-0.5 w-full rounded border px-1 py-1">
          {signers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name || s.label}
            </option>
          ))}
          <option value={SENDER_TARGET}>Me, before sending</option>
        </select>
      </label>
      <div className="flex justify-end gap-2">
        <button className="rounded border px-2 py-1" onClick={onCancel}>
          Cancel
        </button>
        <button className="rounded bg-blue-600 px-2 py-1 text-white" onClick={() => onAdd(type, target)}>
          Add field
        </button>
      </div>
    </div>
  );
}
import { useRouter } from "../router";

export default function ReviewPage({ id }: { id: number }) {
  const { navigate } = useRouter();
  const [env, setEnv] = useState<EnvelopeDetail | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeSignerId, setActiveSignerId] = useState<string | null>(null);
  const [pulseId, setPulseId] = useState<string | null>(null);
  const pulseTimer = useRef<number | undefined>(undefined);
  const previewRef = useRef<HTMLElement>(null);
  const [addMode, setAddMode] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showChecklist, setShowChecklist] = useState(false);
  const [confirmSend, setConfirmSend] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<{ message: string; problems: string[] } | null>(null);
  const draftRef = useRef<Draft | null>(null);
  const editVersion = useRef(0);
  const savedVersion = useRef(0);
  const inFlight = useRef<Promise<void> | null>(null);
  const [pending, setPending] = useState<PageClick | null>(null);

  const createField = (type: FieldType, target: string) => {
    if (!pending || !env) return;
    const page = env.pages.find((p) => p.n === pending.page)!;
    const [w, h] = DEFAULT_SIZE[type];
    const x0 = Math.max(0, Math.min(pending.point[0], page.width - w));
    const y0 = Math.max(0, Math.min(pending.point[1] - h / 2, page.height - h)); // click = vertical middle
    const id = newFieldId();
    apply(
      addField({
        id,
        signer_id: target === SENDER_TARGET ? null : target,
        filled_by: target === SENDER_TARGET ? "sender" : "signer",
        type,
        label: "",
        description: "",
        page: page.n,
        bbox: [x0, y0, x0 + w, y0 + h],
        required: true,
        candidate_id: null,
        placement: "user",
        confidence: null,
        reason: "Added by you",
        source: "user",
        value: null,
      }),
    );
    setPending(null);
    setAddMode(false);
    setSelectedId(id);
  };

  const load = useCallback(() => {
    setError(null);
    api
      .getEnvelope(id)
      .then((e) => {
        if (e.status !== "draft") return navigate(`/envelopes/${id}/status`, true);
        setEnv(e);
        setDraft({ signers: e.signers, fields: e.fields, rejected: e.rejected });
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Couldn't load this envelope."));
  }, [id, navigate]);
  useEffect(load, [load]);

  const apply = useCallback((u: DraftUpdate) => {
    setDraft((d) => (d ? u(d) : d));
    editVersion.current += 1;
    setSaveState("dirty");
  }, []);
  draftRef.current = draft;

  // One bulk PUT with the whole draft. Only one request in flight; edits made meanwhile are saved right after.
  const flush = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current.then(() => flush());
    if (editVersion.current === savedVersion.current || !draftRef.current) return Promise.resolve();
    const run = async () => {
      while (editVersion.current !== savedVersion.current && draftRef.current) {
        const v = editVersion.current;
        setSaveState("saving");
        await api.saveDraft(id, draftRef.current);
        savedVersion.current = v;
      }
      setSaveState("saved");
      setSaveError(null);
    };
    inFlight.current = run()
      .catch((e) => {
        setSaveState("error");
        setSaveError(e instanceof ApiError ? e.message : "network error");
        throw e;
      })
      .finally(() => {
        inFlight.current = null;
      });
    return inFlight.current;
  }, [id]);

  // Autosave ~0.8s after the last edit.
  useEffect(() => {
    if (saveState !== "dirty") return;
    const t = window.setTimeout(() => flush().catch(() => {}), 800);
    return () => window.clearTimeout(t);
  }, [draft, saveState, flush]);

  // Warn before leaving with unsaved edits.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (editVersion.current !== savedVersion.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  const list = useMemo(() => (draft ? checklist(draft) : null), [draft]);

  const doSend = async () => {
    setConfirmSend(false);
    setSending(true);
    setSendError(null);
    try {
      await flush();
      const res = await api.send(id);
      navigate(res.self_sign_token ? `/sign/${res.self_sign_token}` : `/envelopes/${id}/status`);
    } catch (e) {
      setSendError(
        e instanceof ApiError
          ? { message: e.message, problems: e.problems }
          : { message: "Couldn't send. Please try again.", problems: [] },
      );
    } finally {
      setSending(false);
    }
  };
  const onSendClick = () => {
    if (!list || list.blocking > 0) return setShowChecklist(true);
    if (list.reviewLeft > 0) setConfirmSend(true);
    else doSend();
  };

  // Card -> box: scroll the preview to the box, center it, pulse its outline.
  const selectCard = (fieldId: string) => {
    setSelectedId(fieldId);
    setActiveSignerId(null);
    const el = previewRef.current?.querySelector(`[data-box-id="${CSS.escape(fieldId)}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    setPulseId(null);
    window.clearTimeout(pulseTimer.current);
    requestAnimationFrame(() => setPulseId(fieldId)); // restart the animation even for the same box
    pulseTimer.current = window.setTimeout(() => setPulseId(null), 1100);
  };

  // Box -> card: highlight the card and scroll the board to it.
  const selectBox = (fieldId: string) => {
    setSelectedId(fieldId);
    setActiveSignerId(null);
    requestAnimationFrame(() =>
      document
        .querySelector(`[data-card-id="${CSS.escape(fieldId)}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" }),
    );
  };

  // Column header -> highlight all of that signer's boxes.
  const selectSigner = (signerId: string) => {
    setSelectedId(null);
    setActiveSignerId((cur) => (cur === signerId ? null : signerId));
  };

  const boxes: PreviewBox[] = useMemo(() => {
    if (!draft) return [];
    return draft.fields.map((f) => ({
      id: f.id,
      page: f.page,
      bbox: f.bbox,
      color: fieldColor(f, draft.signers),
      dashed: needsReview(f),
      label: boxTag(draft.signers, f),
      title: `${f.label || TYPE_LABEL[f.type]}${f.reason ? `: ${f.reason}` : ""}`,
      pulse: f.id === pulseId,
    }));
  }, [draft, pulseId]);

  const highlighted = useMemo(() => {
    const ids = new Set<string>();
    if (selectedId) ids.add(selectedId);
    if (activeSignerId && draft) draft.fields.filter((f) => f.signer_id === activeSignerId).forEach((f) => ids.add(f.id));
    return ids;
  }, [selectedId, activeSignerId, draft]);

  if (error)
    return (
      <Layout>
        <ErrorBox message={error} onRetry={load} />
      </Layout>
    );
  if (!env || !draft)
    return (
      <Layout>
        <Spinner label="Loading envelope…" />
      </Layout>
    );

  return (
    <Layout wide>
      <div className="flex h-[calc(100vh-3rem)] flex-col">
        <div className="flex items-center gap-3 border-b bg-white px-4 py-2">
          <h1 className="font-semibold">{env.filename}</h1>
          {env.doc_type && <span className="text-sm text-gray-500">{env.doc_type}</span>}
          <div className="ml-auto flex items-center gap-3">
            <SaveStatus state={saveState} error={saveError} onRetry={() => flush().catch(() => {})} />
            {list && (
              <div className="relative">
                <button
                  data-testid="checklist-toggle"
                  onClick={() => setShowChecklist((v) => !v)}
                  className={`rounded px-2 py-1 text-sm ${list.blocking ? "text-red-700" : list.reviewLeft ? "text-amber-700" : "text-green-700"}`}
                >
                  {list.blocking ? `${list.blocking} to fix before sending` : list.reviewLeft ? `${list.reviewLeft} to review` : "Ready to send"} ▾
                </button>
                {showChecklist && <ChecklistPanel list={list} />}
              </div>
            )}
            <span className={list?.blocking ? "cursor-not-allowed" : ""} title={list?.blocking ? "Fix the items in the checklist first" : undefined} onClick={() => list?.blocking && setShowChecklist(true)}>
              <button
                data-testid="send"
                onClick={onSendClick}
                disabled={sending || !list || list.blocking > 0}
                className="rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:pointer-events-none disabled:opacity-50"
              >
                {sending ? "Sending…" : list && list.reviewLeft > 0 && list.blocking === 0 ? "Send anyway…" : "Send"}
              </button>
            </span>
          </div>
        </div>
        {sendError && (
          <div className="border-b px-4 py-2">
            <ErrorBox message={sendError.message} problems={sendError.problems} />
          </div>
        )}
        {env.summary && <div className="border-b bg-white px-4 py-1.5 text-sm text-gray-700">{env.summary}</div>}
        {!dismissed && env.warnings.length > 0 && (
          <div className="flex items-start gap-3 border-b bg-amber-50 px-4 py-2 text-sm text-amber-900">
            <ul className="list-disc space-y-0.5 pl-5">
              {env.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
            <button className="ml-auto shrink-0 underline" onClick={() => setDismissed(true)}>
              Dismiss
            </button>
          </div>
        )}
        <div className="flex min-h-0 flex-1">
          <section className="min-w-0 flex-1">
            <Board
              draft={draft}
              parties={env.parties}
              apply={apply}
              selectedId={selectedId}
              onSelect={selectCard}
              activeSignerId={activeSignerId}
              onSignerHeader={selectSigner}
            />
          </section>
          <aside ref={previewRef} className="relative w-[45%] shrink-0 overflow-y-auto border-l bg-gray-100" data-testid="preview">
            <div className="sticky top-0 z-20 flex items-center gap-2 border-b bg-gray-100/95 px-4 py-2 text-sm">
              <button
                data-testid="add-field"
                onClick={() => {
                  setAddMode((m) => !m);
                  setPending(null);
                }}
                className={`rounded px-2 py-1 font-medium ${addMode ? "bg-blue-600 text-white" : "border border-gray-300 bg-white"}`}
              >
                {addMode ? "Cancel adding" : "+ Add field"}
              </button>
              <span className="text-xs text-gray-600">
                {addMode ? "Click on the page where the field should go." : "Drag boxes to move them; drag edges to resize."}
              </span>
            </div>
            <div className="p-4">
              <PdfPreview
                pages={env.pages}
                boxes={boxes}
                highlighted={highlighted}
                onBoxClick={selectBox}
                onBoxChange={(fid, bbox) => apply(moveFieldBox(fid, bbox))}
                addMode={addMode}
                onPageClick={setPending}
              />
            </div>
          </aside>
          {confirmSend && list && (
            <ConfirmDialog
              text={`${list.reviewLeft} field(s) are still in Needs review: the AI wasn't sure about them. Send anyway?`}
              confirm="Send anyway"
              onConfirm={doSend}
              onCancel={() => setConfirmSend(false)}
            />
          )}
          {pending && (
            <AddFieldPopover at={pending} signers={draft.signers} onAdd={createField} onCancel={() => setPending(null)} />
          )}
        </div>
      </div>
    </Layout>
  );
}
