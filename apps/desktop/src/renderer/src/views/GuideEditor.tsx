import { useCallback, useEffect, useRef, useState } from 'react';
import type { Guide, GuideReport } from '../../../shared/guides';
import { errorText, STATUS_LABEL } from '../labels';
import { markSeen, runGuide } from './run';

/** Edits are saved this long after the last keystroke. */
const SAVE_DELAY_MS = 800;

type Step = Guide['steps'][number];

const ACTION: Record<Step['action'], string> = {
  click: 'Click',
  double_click: 'Double-click',
  type: 'Type',
  select: 'Choose',
  shortcut: 'Shortcut',
  navigate: 'Go to',
  manual: 'Do it yourself',
  wait: 'Wait',
};

const CLARITY: Record<string, string> = {
  vague: 'Check this step',
  needs_info: 'Needs more information',
  manual: "Can't be shown on screen",
  contradiction: 'Contradicts another step',
  outdated: 'May be out of date',
};

function inputLabel(step: Step, guide: Guide): string | null {
  if (step.input === undefined) return null;
  if (typeof step.input === 'string') return `“${step.input}”`;
  const name = step.input.var;
  return guide.variables.find((v) => v.name === name)?.label ?? name;
}

/** The editable parts of a guide, to tell whether there is anything new to save. */
const editKey = (g: Guide) => JSON.stringify([g.title, g.steps]);

export function GuideEditor({
  id,
  editable,
  onBack,
  onDeleted,
}: {
  id: string;
  editable: boolean;
  onBack: () => void;
  onDeleted: () => void;
}) {
  const [draft, setDraft] = useState<Guide | null>(null);
  const [report, setReport] = useState<GuideReport | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [saving, setSaving] = useState<'saving' | 'saved' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'delete' | 'submit' | null>(null);
  // What the server has (as last sent), to know when there is something new to save.
  const sent = useRef<string | null>(null);

  useEffect(() => {
    markSeen(id);
    void window.qhint.guides.get(id).then((g) => {
      if (g.ok) {
        sent.current = editKey(g.value);
        setDraft(g.value);
      } else setError(errorText(g.error));
    });
    void window.qhint.guides.report(id).then((r) => r.ok && setReport(r.value));
  }, [id]);

  const canEdit = editable && draft?.status === 'draft';
  const flags = new Map((report?.flagged ?? []).map((f) => [f.stepId, f]));

  /** Save the draft if it changed since the last save. False if saving failed. */
  const save = useCallback(
    async (g: Guide | null): Promise<boolean> => {
      if (!g || g.status !== 'draft' || !editable) return true;
      const key = editKey(g);
      if (key === sent.current) return true;
      setSaving('saving');
      const r = await window.qhint.guides.update(id, {
        title: g.title.trim() || 'Untitled guide',
        steps: g.steps.map((s) => ({ ...s, instruction: s.instruction.trim() || 'Do this step.' })),
      });
      if (!r.ok) {
        setSaving(null);
        setError(
          r.error === 'invalid'
            ? "Some steps are incomplete, so the last change wasn't saved."
            : errorText(r.error),
        );
        return false;
      }
      sent.current = key;
      setError(null);
      setSaving('saved');
      return true;
    },
    [id, editable],
  );

  // Save shortly after each change.
  useEffect(() => {
    if (!draft || editKey(draft) === sent.current) return;
    const t = setTimeout(() => void save(draft), SAVE_DELAY_MS);
    return () => clearTimeout(t);
  }, [draft, save]);

  const leave = async () => {
    await save(draft);
    onBack();
  };

  if (!draft) {
    return (
      <>
        <button className="btn ghost small" onClick={onBack}>
          ← Back
        </button>
        {error ? <div className="notice error">{error}</div> : <p className="muted">Loading…</p>}
      </>
    );
  }

  const setStep = (i: number, patch: Partial<Step>) =>
    setDraft({
      ...draft,
      steps: draft.steps.map((s, k) => (k === i ? ({ ...s, ...patch } as Step) : s)),
    });
  const move = (i: number, by: number) => {
    const steps = [...draft.steps];
    const [s] = steps.splice(i, 1);
    steps.splice(i + by, 0, s!);
    setDraft({ ...draft, steps });
  };
  const remove = (i: number) =>
    setDraft({ ...draft, steps: draft.steps.filter((_, k) => k !== i) });

  const startRun = async () => {
    if (!(await save(draft))) return;
    await runGuide(id, (e) => setError(e));
  };

  const doConfirm = async () => {
    const what = confirm;
    setConfirm(null);
    setBusy(what);
    if (what === 'delete') {
      const r = await window.qhint.guides.remove(id);
      setBusy(null);
      if (r.ok) onDeleted();
      else setError(errorText(r.error));
    } else if (what === 'submit') {
      if (!(await save(draft))) return setBusy(null);
      const r = await window.qhint.guides.submit(id);
      setBusy(null);
      if (r.ok) {
        setDraft({ ...draft, status: 'in_review' });
        setNotice('Sent to your admins for review');
      } else setError(errorText(r.error));
    }
  };

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <button className="btn ghost small" onClick={() => void leave()}>
          ← Back
        </button>
        <div className="row">
          {canEdit ? (
            <button className="btn danger" disabled={!!busy} onClick={() => setConfirm('delete')}>
              Delete
            </button>
          ) : null}
          {canEdit ? (
            <button className="btn" disabled={!!busy} onClick={() => setConfirm('submit')}>
              Share with company…
            </button>
          ) : null}
          <button className="btn primary" disabled={!!busy} onClick={() => void startRun()}>
            ▶ Run guide
          </button>
        </div>
      </div>

      <input
        className="title-input"
        value={draft.title}
        disabled={!canEdit}
        maxLength={300}
        aria-label="Guide name"
        onChange={(e) => setDraft({ ...draft, title: e.target.value })}
      />
      <p className="sub" style={{ margin: '4px 0 0' }}>
        <span className={`pill ${draft.status}`}>{STATUS_LABEL[draft.status]}</span> ·{' '}
        {draft.steps.length} steps · {draft.apps.map((a) => a.name).join(', ') || 'any app'}
        {canEdit && saving ? (
          <span className="muted"> · {saving === 'saving' ? 'Saving…' : 'Saved'}</span>
        ) : null}
      </p>
      {canEdit ? (
        <p className="muted small" style={{ margin: '6px 0 0' }}>
          Click any step to change its wording. Changes save automatically.
        </p>
      ) : null}
      {report?.summary ? <p className="muted">{report.summary}</p> : null}

      {flags.size && canEdit ? (
        <div className="notice warn">
          Qhint wasn&apos;t sure about {flags.size === 1 ? 'one step' : `${flags.size} steps`}: they
          are marked below. Read them and fix the wording if needed.
        </div>
      ) : null}
      {report?.problems.length && canEdit ? (
        <details className="muted small" style={{ margin: '8px 0 14px' }}>
          <summary>Notes from creating this guide</summary>
          <ul>
            {report.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {error ? <div className="notice error">{error}</div> : null}

      <h2>Steps</h2>
      <div className="steps">
        {draft.steps.map((s, i) => {
          const flag = flags.get(s.id);
          const input = inputLabel(s, draft);
          return (
            <div className={`step${flag ? ' flagged' : ''}`} key={s.id}>
              <div className="step-num">{i + 1}</div>
              <div>
                {canEdit ? (
                  <textarea
                    rows={1}
                    value={s.instruction}
                    maxLength={2000}
                    aria-label={`Step ${i + 1} instruction`}
                    onChange={(e) => setStep(i, { instruction: e.target.value })}
                  />
                ) : (
                  <div>{s.instruction}</div>
                )}
                <div className="step-meta">
                  <span className="tag">{ACTION[s.action]}</span>
                  {s.target?.text ? <span className="tag">“{s.target.text}”</span> : null}
                  {input ? <span className="tag">Value: {input}</span> : null}
                  {s.target?.exemplar ? (
                    <span className="tag" title="A picture of this button was saved from the video">
                      📷 picture
                    </span>
                  ) : null}
                  <span>{s.app.name}</span>
                </div>
                {flag && canEdit ? (
                  <div className="step-note">
                    <strong>{CLARITY[flag.clarity] ?? 'Check this step'}:</strong> {flag.note}
                  </div>
                ) : null}
              </div>
              {canEdit ? (
                <div className="step-tools">
                  <button
                    className="icon-btn"
                    title="Move up"
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                  >
                    ↑
                  </button>
                  <button
                    className="icon-btn"
                    title="Move down"
                    disabled={i === draft.steps.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    ↓
                  </button>
                  <button
                    className="icon-btn"
                    title="Remove step"
                    disabled={draft.steps.length === 1}
                    onClick={() => remove(i)}
                  >
                    ✕
                  </button>
                </div>
              ) : (
                <div />
              )}
            </div>
          );
        })}
      </div>

      {notice ? <div className="notice ok">{notice}</div> : null}

      {confirm ? (
        <div className="scrim" onClick={() => setConfirm(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            {confirm === 'delete' ? (
              <>
                <h3>Delete this guide?</h3>
                <p className="muted">“{draft.title}” will be deleted. This can&apos;t be undone.</p>
              </>
            ) : (
              <>
                <h3>Share with your company?</h3>
                <p className="muted">
                  Your admins will review “{draft.title}” and can publish it to the company library.
                  You won&apos;t be able to edit it while it&apos;s in review.
                </p>
              </>
            )}
            <div className="row">
              <button className="btn ghost" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                className={`btn ${confirm === 'delete' ? 'danger' : 'primary'}`}
                onClick={() => void doConfirm()}
              >
                {confirm === 'delete' ? 'Delete' : 'Send for review'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
