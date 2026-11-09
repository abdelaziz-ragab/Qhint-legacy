import { useEffect, useState } from 'react';
import { GUIDE_SOURCES } from '../../../shared/guides';
import { errorText, LANGUAGES } from '../labels';

const VIDEO = new Set<string>(GUIDE_SOURCES.video);
const DOC = new Set<string>(GUIDE_SOURCES.doc);
const LANGUAGE_KEY = 'qhint.language';

const extOf = (path: string) => path.split('.').pop()?.toLowerCase() ?? '';
const nameOf = (path: string) => path.split(/[\\/]/).pop() ?? path;
/** A readable placeholder name; the AI gives the guide its real name. */
const titleFrom = (path: string) =>
  nameOf(path)
    .replace(/\.[^.]+$/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase());

/** The last language used, else the computer's language, else English. */
function startLanguage(): string {
  const saved = localStorage.getItem(LANGUAGE_KEY);
  if (saved && LANGUAGES.some((l) => l.name === saved)) return saved;
  const code = navigator.language.slice(0, 2);
  return LANGUAGES.find((l) => l.speech.startsWith(code))?.name ?? 'English';
}

export function CreateGuide({ onCreated }: { onCreated: () => void }) {
  const [language, setLanguage] = useState(startLanguage);
  const [changingLanguage, setChangingLanguage] = useState(false);
  const [over, setOver] = useState(false);
  const [file, setFile] = useState<string | null>(null);
  const [sending, setSending] = useState<{ sent: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () =>
      window.qhint.guides.onUploadProgress((p) =>
        setSending({ sent: p.sentBytes, total: p.totalBytes }),
      ),
    [],
  );

  /** Choosing a file starts creating the guide right away. */
  const start = async (path: string | null) => {
    setError(null);
    if (!path || sending) return;
    const ext = extOf(path);
    if (!VIDEO.has(ext) && !DOC.has(ext)) {
      setError(
        `Qhint can use videos (${GUIDE_SOURCES.video.join(', ')}) and documents (${GUIDE_SOURCES.doc.join(', ')}).`,
      );
      return;
    }
    const lang = LANGUAGES.find((l) => l.name === language) ?? LANGUAGES[0]!;
    setFile(path);
    setSending({ sent: 0, total: 1 });
    const r = await window.qhint.guides.create({
      path,
      title: titleFrom(path),
      language: lang.speech,
      outputLanguage: lang.name,
    });
    setSending(null);
    if (r.ok) onCreated();
    else {
      setFile(null);
      setError(errorText(r.error));
    }
  };

  const pick = async () => {
    if (sending) return;
    const r = await window.qhint.guides.pickFile();
    if (r.ok) void start(r.value);
    else setError(errorText(r.error));
  };

  const pct = sending ? Math.round((sending.sent / Math.max(1, sending.total)) * 100) : 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Create a guide</h1>
          <p className="sub">
            Upload a screen recording of someone doing the task, or a written procedure (PDF or
            text). Qhint turns it into a step-by-step guide that points at each button live.
          </p>
        </div>
      </div>

      <div className="form">
        {sending && file ? (
          <div className="drop busy">
            <strong>{nameOf(file)}</strong>
            <span className="muted small">{pct < 100 ? `Uploading… ${pct}%` : 'Starting…'}</span>
            <div className="progress" style={{ width: '60%' }}>
              <div style={{ width: `${pct}%` }} />
            </div>
          </div>
        ) : (
          <div
            className={`drop${over ? ' over' : ''}`}
            role="button"
            tabIndex={0}
            onClick={() => void pick()}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && void pick()}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              const f = e.dataTransfer.files[0];
              if (f) void start(window.qhint.guides.pathOf(f));
            }}
          >
            <div className="drop-icon">⬆</div>
            <strong>Drop a video or document here</strong>
            <span className="muted small">
              or click to choose a file · MP4, MOV, WebM, PDF, text
            </span>
          </div>
        )}

        <div className="muted small">
          {changingLanguage ? (
            <label>
              Language of the video and the guide:{' '}
              <select
                autoFocus
                value={language}
                onChange={(e) => {
                  setLanguage(e.target.value);
                  localStorage.setItem(LANGUAGE_KEY, e.target.value);
                  setChangingLanguage(false);
                }}
                onBlur={() => setChangingLanguage(false)}
              >
                {LANGUAGES.map((l) => (
                  <option key={l.name}>{l.name}</option>
                ))}
              </select>
            </label>
          ) : (
            <>
              Language: {language} ·{' '}
              <button
                className="link"
                disabled={!!sending}
                onClick={() => setChangingLanguage(true)}
              >
                change
              </button>
            </>
          )}
          <div style={{ marginTop: 4 }}>
            A short video takes about a minute. The video is deleted once the guide is made.
          </div>
        </div>

        {error ? <div className="notice error">{error}</div> : null}
      </div>
    </>
  );
}
