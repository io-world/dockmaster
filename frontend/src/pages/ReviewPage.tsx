import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type Draft, type EnvelopeDetail, type Field, type FieldType } from "../api";
import Layout from "../components/Layout";
import PdfPreview, { type PageClick, type PreviewBox } from "../components/PdfPreview";
import { ConfirmDialog, ErrorBox, Spinner } from "../components/ui";
import DocChat from "../components/DocChat";
import Board from "../review/Board";
import { checklist, type Checklist } from "../review/checklist";
import { addField, DEFAULT_SIZE, moveFieldBox, newFieldId, newGroupId, resetToAi, type DraftUpdate } from "../review/draft";
import { boxTag, FIELD_TYPES, fieldColor, groupName, needsReview, radioGroup, TYPE_LABEL } from "../review/model";

/** Pre-filled values are drawn on the page the way they will be stamped. */
function previewContent(f: Field): PreviewBox["content"] {
  const v = (f.value ?? "").trim();
  if (!v || v === "false" || f.type === "signature" || f.type === "initials") return undefined;
  if (f.type === "checkbox") return { kind: "check", value: v };
  if (f.type === "radio") return { kind: "radio", value: v };
  return { kind: "text", value: v };
}

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

/** Popover after clicking the page in "+ Add field" mode: pick type and who fills it. */
function AddFieldPopover({
  at,
  signers,
  fields,
  onAdd,
  onCancel,
}: {
  at: PageClick;
  signers: Draft["signers"];
  fields: Field[];
  onAdd: (type: FieldType, target: string, groupId: string | null) => void;
  onCancel: () => void;
}) {
  const [type, setType] = useState<FieldType>("signature");
  const [target, setTarget] = useState(signers[0]?.id ?? "");
  const [group, setGroup] = useState<string>(""); // "" = a new choice
  // Radio: join an existing choice on this page (it keeps that choice's owner) or start a new one.
  const choices = useMemo(() => {
    const seen = new Map<string, Field>();
    for (const f of fields) if (f.type === "radio" && f.group_id && f.page === at.page && !seen.has(f.group_id)) seen.set(f.group_id, f);
    return [...seen].map(([id, f]) => ({ id, name: groupName(radioGroup(fields, f)) }));
  }, [fields, at.page]);
  const joining = type === "radio" && group !== "";
  const left = Math.min(at.clientX + 8, window.innerWidth - 260);
  const top = Math.min(at.clientY + 8, window.innerHeight - 170);
  return (
    <div data-testid="add-popover" className="fixed z-50 w-60 space-y-2 rounded border bg-white p-3 text-sm shadow-lg" style={{ left, top }}>
      <div className="font-medium">New field on page {at.page}</div>
      <label className="block">
        Type
        <select value={type} onChange={(e) => setType(e.target.value as FieldType)} className="mt-0.5 w-full rounded border px-1 py-1">
          {FIELD_TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </select>
      </label>
      {type === "radio" && (
        <label className="block">
          Choice
          <select data-testid="add-radio-group" value={group} onChange={(e) => setGroup(e.target.value)} className="mt-0.5 w-full rounded border px-1 py-1">
            <option value="">New choice</option>
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                Add to: {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className={`block ${joining ? "hidden" : ""}`}>
        Who it belongs to
        <select value={target} onChange={(e) => setTarget(e.target.value)} className="mt-0.5 w-full rounded border px-1 py-1">
          <option value="">Decide later (Needs review)</option>
          {signers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name || s.label}
            </option>
          ))}
        </select>
      </label>
      <div className="flex justify-end gap-2">
        <button className="rounded border px-2 py-1" onClick={onCancel}>
          Cancel
        </button>
        <button className="rounded bg-blue-600 px-2 py-1 text-white" onClick={() => onAdd(type, target, type === "radio" ? group || newGroupId() : null)}>
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
  // AI summary panel: expandable/minimisable (never dismissed). The choice is remembered per browser.
  const [summaryOpen, setSummaryOpen] = useState(() => {
    try {
      return localStorage.getItem("dm.summaryOpen") !== "false";
    } catch {
      return true;
    }
  });
  const toggleSummary = () =>
    setSummaryOpen((o) => {
      try {
        localStorage.setItem("dm.summaryOpen", String(!o));
      } catch {
        /* storage unavailable: just don't remember */
      }
      return !o;
    });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeSignerId, setActiveSignerId] = useState<string | null>(null);
  const [pulseId, setPulseId] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ fieldId: string; nonce: number } | null>(null);
  const pulseTimer = useRef<number | undefined>(undefined);
  const previewRef = useRef<HTMLElement>(null);
  const [addMode, setAddMode] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showChecklist, setShowChecklist] = useState(false);
  const [confirmSend, setConfirmSend] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<{ message: string; problems: string[] } | null>(null);
  const draftRef = useRef<Draft | null>(null);
  const editVersion = useRef(0);
  const savedVersion = useRef(0);
  const inFlight = useRef<Promise<void> | null>(null);
  const [pending, setPending] = useState<PageClick | null>(null);

  const createField = (type: FieldType, target: string, groupId: string | null) => {
    if (!pending || !env) return;
    const page = env.pages.find((p) => p.n === pending.page)!;
    const [w, h] = DEFAULT_SIZE[type];
    const x0 = Math.max(0, Math.min(pending.point[0], page.width - w));
    const y0 = Math.max(0, Math.min(pending.point[1] - h / 2, page.height - h)); // click = vertical middle
    const id = newFieldId();
    // Joining an existing choice: take its owner, so one choice never has two owners.
    const owner = groupId ? draft?.fields.find((f) => f.type === "radio" && f.group_id === groupId) : undefined;
    apply(
      addField({
        id,
        signer_id: owner ? owner.signer_id : target || null,
        filled_by: "signer",
        type,
        group_id: groupId,
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

  // Box -> card: highlight the card; the board opens its section (if collapsed) and scrolls to it.
  const selectBox = (fieldId: string) => {
    setSelectedId(fieldId);
    setActiveSignerId(null);
    setReveal((r) => ({ fieldId, nonce: (r?.nonce ?? 0) + 1 }));
  };

  // Page reference in a chat answer -> scroll the preview to that page.
  const showPage = (n: number) =>
    previewRef.current?.querySelector(`[data-page="${n}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });

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
      content: previewContent(f),
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
            <button
              data-testid="reset-ai"
              onClick={() => setConfirmReset(true)}
              disabled={!env.ai_draft}
              title={env.ai_draft ? "Undo your changes to fields and who fills them" : "Only available for documents uploaded after this update"}
              className="rounded border border-gray-300 px-2 py-1 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Reset to AI suggestions
            </button>
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
        {(env.summary || env.warnings.length > 0) && (
          <div data-testid="ai-summary" className={`border-b text-sm ${env.warnings.length ? "bg-amber-50 text-amber-950" : "bg-white text-gray-700"}`}>
            <button
              data-testid="ai-summary-toggle"
              onClick={toggleSummary}
              aria-expanded={summaryOpen}
              className="flex w-full items-center gap-2 px-4 py-1.5 text-left"
            >
              <span className="w-4 shrink-0 text-gray-500">{summaryOpen ? "▾" : "▸"}</span>
              <span className="shrink-0 font-medium">AI summary &amp; questions</span>
              {env.warnings.length > 0 && (
                <span className="shrink-0 rounded bg-amber-200 px-1.5 text-xs text-amber-900">
                  {env.warnings.length} note{env.warnings.length === 1 ? "" : "s"}
                </span>
              )}
              {/* Minimised: the one-line summary stays visible. */}
              {!summaryOpen && env.summary && <span className="min-w-0 truncate text-gray-700">{env.summary}</span>}
              {!summaryOpen && <span className="shrink-0 text-xs text-blue-700">Ask a question</span>}
              <span className="ml-auto shrink-0 text-xs text-gray-500 underline">{summaryOpen ? "Minimise" : "Expand"}</span>
            </button>
            {/* Kept mounted when minimised so the chat conversation survives. */}
            <div className={summaryOpen ? "pb-2 pl-10 pr-4" : "hidden"}>
              <div className="max-h-40 overflow-y-auto">
                {env.summary && <p className="mb-1 text-gray-800">{env.summary}</p>}
                {env.warnings.length > 0 && (
                  <ul className="list-disc space-y-0.5 pl-5 text-amber-900">
                    {env.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="mt-2 border-t border-amber-200/70 pt-2">
                <DocChat
                  ask={(q, h) => api.askEnvelope(id, q, h)}
                  starters={["Who needs to sign?", "Summarise the key terms", "Any deadlines or dates?"]}
                  onPage={showPage}
                />
              </div>
            </div>
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
              reveal={reveal}
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
          {confirmReset && env.ai_draft && (
            <ConfirmDialog
              text={
                <>
                  Undo all your changes to fields and who fills them? Every box goes back to the AI's suggestion: its
                  signer, type and position. Removed fields come back and fields you added are deleted. Signer names,
                  emails and "You fill" values are kept.
                </>
              }
              confirm="Reset"
              danger
              onConfirm={() => {
                apply(resetToAi(env.ai_draft!));
                setConfirmReset(false);
                setSelectedId(null);
                setActiveSignerId(null);
              }}
              onCancel={() => setConfirmReset(false)}
            />
          )}
          {pending && (
            <AddFieldPopover at={pending} signers={draft.signers} fields={draft.fields} onAdd={createField} onCancel={() => setPending(null)} />
          )}
        </div>
      </div>
    </Layout>
  );
}
