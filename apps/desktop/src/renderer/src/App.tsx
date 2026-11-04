import { useEffect, useState } from 'react';
import type { AppInfo, AuthStatus, ProcedureLists } from '../../shared/ipc';

const styles = {
  page: {
    fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    padding: 24,
    color: '#1d2433',
  },
  muted: { color: '#5b6478', fontSize: 13 },
  error: { color: '#b42318', fontSize: 13 },
  row: { display: 'flex', gap: 8, margin: '12px 0', flexWrap: 'wrap' as const },
  button: {
    font: 'inherit',
    padding: '8px 12px',
    borderRadius: 8,
    border: '1px solid #ccd2dc',
    background: '#fff',
    cursor: 'pointer',
  },
  primary: { background: '#1d2433', color: '#fff', border: '1px solid #1d2433' },
  section: { borderTop: '1px solid #eef0f3', marginTop: 16, paddingTop: 12 },
  pre: {
    fontSize: 12,
    background: '#f4f5f7',
    padding: 12,
    borderRadius: 8,
    whiteSpace: 'pre-wrap' as const,
  },
  list: { margin: '4px 0 8px', paddingLeft: 18, fontSize: 14 },
} as const;

const ERRORS: Record<string, string> = {
  sign_in_timeout: 'Sign-in timed out. Please try again.',
};

function Procedures({ lists }: { lists: ProcedureLists }) {
  const render = (items: ProcedureLists['mine'], empty: string) =>
    items.length === 0 ? (
      <p style={styles.muted}>{empty}</p>
    ) : (
      <ul style={styles.list}>
        {items.map((p) => (
          <li key={p.id}>
            {p.title} <span style={styles.muted}>· {p.status}</span>
          </li>
        ))}
      </ul>
    );
  return (
    <>
      <strong>Company library</strong>
      {render(lists.company, 'No published procedures yet.')}
      <strong>My procedures</strong>
      {render(lists.mine, 'You have no procedures yet.')}
    </>
  );
}

export function App() {
  const { platform, versions } = window.qhint;
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [lists, setLists] = useState<ProcedureLists | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  useEffect(() => {
    void window.qhint.appInfo().then(setInfo);
    void window.qhint.auth.status().then(setAuth);
  }, []);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  const signIn = () =>
    run('signin', async () => {
      setAuth(await window.qhint.auth.signIn());
    });
  const signOut = () =>
    run('signout', async () => {
      setLists(null);
      setAuth(await window.qhint.auth.signOut());
    });
  const loadProcedures = () =>
    run('procedures', async () => {
      setLists(await window.qhint.procedures());
    });
  const [guideError, setGuideError] = useState<string | null>(null);
  const runSample = () =>
    run('sample', async () => {
      setGuideError(null);
      const r = await window.qhint.runSample('libreoffice-insert-table');
      if (r && !r.ok) setGuideError(r.error ?? 'failed');
    });
  const runDebug = () =>
    run('debug', async () => {
      setSummary(await window.qhint.debugRings());
    });

  return (
    <main style={styles.page}>
      <h1>Qhint</h1>

      {auth?.signedIn ? (
        <>
          <p>
            {auth.email ?? 'Signed in'} · <strong>{auth.tenantName}</strong> · {auth.role}
          </p>
          <div style={styles.row}>
            <button style={styles.button} disabled={!!busy} onClick={() => void loadProcedures()}>
              {busy === 'procedures' ? 'Loading…' : 'Show procedures'}
            </button>
            <button style={styles.button} disabled={!!busy} onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
          {lists ? <Procedures lists={lists} /> : null}
        </>
      ) : (
        <>
          <p style={styles.muted}>Sign in with your work account to continue.</p>
          <div style={styles.row}>
            <button
              style={{ ...styles.button, ...styles.primary }}
              disabled={!!busy}
              onClick={() => void signIn()}
            >
              {busy === 'signin' ? 'Waiting for browser…' : 'Sign in'}
            </button>
          </div>
          {auth && !auth.signedIn && auth.error ? (
            <p style={styles.error}>{ERRORS[auth.error] ?? 'Sign-in failed. Please try again.'}</p>
          ) : null}
        </>
      )}

      <p style={styles.muted}>
        Hotkey: {info?.hotkey ?? 'unavailable'}
        {info?.hotkeyIsFallback ? ' (fallback; default was taken)' : ''}
      </p>

      {info?.debugTools ? (
        <div style={styles.section}>
          <p style={styles.muted}>Developer tools</p>
          <div style={styles.row}>
            <button
              style={styles.button}
              disabled={!!busy || !auth?.signedIn}
              onClick={() => void runSample()}
              title={auth?.signedIn ? '' : 'Sign in first'}
            >
              Run sample guide: LibreOffice — insert a table
            </button>
          </div>
          {guideError ? (
            <p style={styles.error}>Couldn&apos;t start the guide: {guideError}</p>
          ) : null}
          <div style={styles.row}>
            <button style={styles.button} disabled={!!busy} onClick={() => void runDebug()}>
              {busy === 'debug' ? 'Capturing…' : 'Debug: capture + draw rings'}
            </button>
            <button style={styles.button} onClick={() => void window.qhint.clearOverlay()}>
              Clear overlay
            </button>
          </div>
          {summary ? <pre style={styles.pre}>{summary}</pre> : null}
        </div>
      ) : null}

      <p style={styles.muted}>
        {platform} · Electron {versions.electron} · Chrome {versions.chrome}
      </p>
    </main>
  );
}
