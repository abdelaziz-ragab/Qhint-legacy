import { useEffect, useState } from 'react';
import type { GuideJob, GuideSummary } from '../../../shared/guides';
import { errorText, SOURCE_ICON, STAGE_LABEL, STATUS_LABEL, timeAgo } from '../labels';
import { runGuide, seenGuides } from './run';

const ACTIVE = new Set(['queued', 'running']);

/** Guides still being made, and ones that failed recently (so you see why). */
const visibleJob = (j: GuideJob) =>
  ACTIVE.has(j.status) ||
  (j.status === 'failed' && Date.now() - new Date(j.createdAt).getTime() < 30 * 60_000);

export function MyGuides({
  onOpen,
  onCreate,
  onCounts,
}: {
  onOpen: (id: string, editable: boolean) => void;
  onCreate: () => void;
  onCounts: (mine: number) => void;
}) {
  const [guides, setGuides] = useState<GuideSummary[] | null>(null);
  const [jobs, setJobs] = useState<GuideJob[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const run = (id: string) => void runGuide(id, setError);
  // Bumped to reload the lists (e.g. when a guide finishes being created).
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    void Promise.all([window.qhint.guides.lists(), window.qhint.guides.jobs()]).then(([l, j]) => {
      if (!live) return;
      if (l.ok) {
        setGuides(l.value.mine);
        onCounts(l.value.mine.length);
      } else setError(errorText(l.error));
      if (j.ok) setJobs(j.value);
    });
    return () => {
      live = false;
    };
  }, [reload, onCounts]);

  // While something is being created, check on it every two seconds.
  const active = jobs.some((j) => ACTIVE.has(j.status));
  useEffect(() => {
    if (!active) return;
    const t = setInterval(async () => {
      const j = await window.qhint.guides.jobs();
      if (!j.ok) return;
      setJobs(j.value);
      // Something just finished: reload so its guide appears in the list.
      if (!j.value.some((x) => ACTIVE.has(x.status))) setReload((r) => r + 1);
    }, 2000);
    return () => clearInterval(t);
  }, [active]);

  const shownJobs = jobs.filter((j) => visibleJob(j) && !dismissed.has(j.id));
  // Guides made from an upload that haven't been opened yet.
  const seen = seenGuides();
  const fresh = new Set(
    jobs.flatMap((j) => (j.procedureId && !seen.has(j.procedureId) ? [j.procedureId] : [])),
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>My guides</h1>
          <p className="sub">Guides you created. Only you can see them until you share them.</p>
        </div>
        <button className="btn primary" onClick={onCreate}>
          + Create guide
        </button>
      </div>

      {error ? <div className="notice error">{error}</div> : null}

      {guides === null ? (
        <p className="muted">Loading…</p>
      ) : guides.length === 0 && shownJobs.length === 0 ? (
        <div className="empty">
          <p style={{ marginTop: 0 }}>You haven&apos;t created any guides yet.</p>
          <p className="small">
            Upload a screen recording or a written procedure, and Qhint turns it into a live guide.
          </p>
          <button className="btn primary" onClick={onCreate}>
            Create your first guide
          </button>
        </div>
      ) : (
        <div className="list">
          {shownJobs.map((j) => (
            <div className="item" key={j.id}>
              <div className="item-icon">{SOURCE_ICON[j.kind]}</div>
              <div className="item-main">
                <div className="item-title">{j.title}</div>
                {j.status === 'failed' ? (
                  <div className="item-meta" style={{ color: 'var(--bad)' }}>
                    Couldn&apos;t create this guide: {errorText(j.errorCode)}
                  </div>
                ) : (
                  <>
                    <div className="item-meta">{STAGE_LABEL[j.stage]}</div>
                    <div className={`progress${j.stage === 'queued' ? ' indeterminate' : ''}`}>
                      <div style={{ width: `${Math.max(4, j.progress)}%` }} />
                    </div>
                  </>
                )}
              </div>
              {j.status === 'failed' ? (
                <button
                  className="icon-btn"
                  title="Hide"
                  onClick={() => setDismissed(new Set([...dismissed, j.id]))}
                >
                  ✕
                </button>
              ) : null}
            </div>
          ))}
          {guides.map((g) => (
            <div className="item" key={g.id}>
              <div className="item-icon">{SOURCE_ICON[g.source]}</div>
              <div
                className="item-main"
                style={{ cursor: 'pointer' }}
                onClick={() => onOpen(g.id, g.status === 'draft')}
              >
                <div className="item-title">{g.title}</div>
                <div className="item-meta">
                  {fresh.has(g.id) ? (
                    <span className="pill new">New</span>
                  ) : (
                    <span className={`pill ${g.status}`}>{STATUS_LABEL[g.status]}</span>
                  )}{' '}
                  · updated {timeAgo(g.updatedAt)}
                </div>
              </div>
              <button className="btn primary" onClick={() => run(g.id)}>
                ▶ Run
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export function Library({ onOpen }: { onOpen: (id: string, editable: boolean) => void }) {
  const [guides, setGuides] = useState<GuideSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const run = (id: string) => void runGuide(id, setError);

  useEffect(() => {
    void window.qhint.guides.lists().then((l) => {
      if (l.ok) setGuides(l.value.company);
      else setError(errorText(l.error));
    });
  }, []);

  const q = query.trim().toLowerCase();
  const shown = guides?.filter((g) => !q || g.title.toLowerCase().includes(q)) ?? null;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Company library</h1>
          <p className="sub">Guides your company has published for everyone.</p>
        </div>
      </div>
      {error ? <div className="notice error">{error}</div> : null}
      {guides && guides.length > 0 ? (
        <div className="field" style={{ maxWidth: 360, marginBottom: 14 }}>
          <input
            placeholder="Search guides"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      ) : null}
      {shown === null ? (
        <p className="muted">Loading…</p>
      ) : shown.length === 0 ? (
        <div className="empty">
          {guides?.length ? 'No guides match your search.' : 'Nothing has been published yet.'}
        </div>
      ) : (
        <div className="list">
          {shown.map((g) => (
            <div className="item" key={g.id}>
              <div className="item-icon">{SOURCE_ICON[g.source]}</div>
              <div
                className="item-main"
                style={{ cursor: 'pointer' }}
                onClick={() => onOpen(g.id, false)}
              >
                <div className="item-title">{g.title}</div>
                <div className="item-meta">updated {timeAgo(g.updatedAt)}</div>
              </div>
              <button className="btn primary" onClick={() => run(g.id)}>
                ▶ Run
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
