import { useEffect, useState } from 'react';
import type { PanelAction, PanelView } from '../../../shared/panel';

function status(view: PanelView): { text: string; tone: 'info' | 'warn' | 'ok' } | null {
  if (view.confirmed) return { text: '✓ Done', tone: 'ok' };
  // Notices that apply whatever the phase.
  if (view.notice?.kind === 'missed') {
    return {
      text: `It looks like this step didn't happen yet.${view.notice.hint ? ` ${view.notice.hint}` : ''}`,
      tone: 'warn',
    };
  }
  if (view.notice?.kind === 'went_back') {
    return { text: 'That closed before the step was finished. Pick up from here.', tone: 'info' };
  }
  if (view.notice?.kind === 'wrong_click' && view.phase !== 'HIGHLIGHTING') {
    return { text: "That wasn't the highlighted item. Looking again…", tone: 'warn' };
  }
  if (view.notice?.kind === 'wrong_click') {
    return { text: 'Click the highlighted item.', tone: 'warn' };
  }
  if (view.notice?.kind === 'off_track') {
    return {
      text: `Something unexpected happened.${view.notice.hint ? ` ${view.notice.hint}` : ''} Fix it, then press Try again.`,
      tone: 'warn',
    };
  }
  switch (view.phase) {
    case 'VERIFYING':
      return { text: 'Checking that it worked…', tone: 'info' };
    case 'HIGHLIGHTING':
      return view.autoAdvance
        ? null
        : { text: 'Press Next when you’ve done this step.', tone: 'info' };
    case 'LOCATING':
      return { text: 'Finding it on your screen…', tone: 'info' };
    case 'RECOVERING':
      return { text: 'Looking more carefully…', tone: 'info' };
    case 'NEEDS_NAVIGATION':
      return { text: view.notice?.hint || "I'll continue as soon as it's ready.", tone: 'info' };
    case 'TEXT_ONLY':
      if (view.notice?.kind === 'no_target') {
        return { text: view.notice.hint || 'Do this yourself, then press Next.', tone: 'info' };
      }
      if (view.notice?.kind === 'not_found') {
        return {
          text: `I can't see it on your screen right now.${view.notice.hint ? ` ${view.notice.hint}` : ''}`,
          tone: 'warn',
        };
      }
      if (view.notice?.kind === 'stuck') {
        return {
          text: "I still can't find it. Follow the instruction, then press Next. We've noted this so the guide can be improved.",
          tone: 'warn',
        };
      }
      if (view.notice?.kind === 'error') {
        return {
          text: "Couldn't reach Qhint. You can still follow the instruction.",
          tone: 'warn',
        };
      }
      return null;
    default:
      return null;
  }
}

export function Panel() {
  const [view, setView] = useState<PanelView | null>(null);

  useEffect(() => {
    window.qhintPanel.onView(setView);
  }, []);

  if (!view) return null;
  const act = (a: PanelAction) => () => window.qhintPanel.act(a);
  const busy =
    view.phase === 'LOCATING' || view.phase === 'RECOVERING' || view.phase === 'VERIFYING';
  const note = status(view);

  if (view.phase === 'COMPLETE') {
    return (
      <main className="panel">
        <header>
          <span className="progress">Done</span>
          <button className="close" aria-label="Close guide" onClick={act('stop')}>
            ×
          </button>
        </header>
        {view.notice?.kind === 'missed' ? (
          <>
            <p className="instruction">Finished, but one thing was left undone:</p>
            <p className="status warn">{view.notice.hint}</p>
          </>
        ) : (
          <>
            <p className="instruction">All {view.totalSteps} steps complete. Nice work!</p>
            <p className="title">{view.title}</p>
          </>
        )}
        <footer>
          <button className="primary" onClick={act('stop')}>
            Close
          </button>
        </footer>
      </main>
    );
  }

  return (
    <main className="panel" aria-live="polite">
      <header>
        <span className="progress">
          {view.progressLabel ?? `Step ${view.stepNumber} of ${view.totalSteps}`}
        </span>
        <button className="close" aria-label="Stop guide" onClick={act('stop')}>
          ×
        </button>
      </header>
      <p className="instruction">{view.instruction}</p>
      {view.typeText ? (
        <p className="type-chip">
          Type: <strong>{view.typeText}</strong>
        </p>
      ) : null}
      {view.expected ? <p className="expected">You should then see: {view.expected}</p> : null}
      {note ? (
        <p className={`status ${note.tone}`} role="status">
          {busy ? <span className="spinner" aria-hidden="true" /> : null}
          {note.text}
        </p>
      ) : null}
      <footer>
        <button onClick={act('back')} disabled={!view.canGoBack}>
          Back
        </button>
        <button onClick={act('skip')}>Skip</button>
        {view.notice?.kind === 'off_track' ? (
          <button onClick={act('retry')}>Try again</button>
        ) : (
          <button onClick={act('stuck')} disabled={busy}>
            I&apos;m stuck
          </button>
        )}
        <button className="primary" onClick={act('next')}>
          Next
        </button>
      </footer>
    </main>
  );
}
