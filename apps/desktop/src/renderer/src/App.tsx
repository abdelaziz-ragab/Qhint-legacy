import { useCallback, useEffect, useState } from 'react';
import type { AppInfo, AuthStatus } from '../../shared/ipc';
import { errorText } from './labels';
import { CreateGuide } from './views/CreateGuide';
import { GuideEditor } from './views/GuideEditor';
import { Library, MyGuides } from './views/MyGuides';

type View =
  | { name: 'mine' }
  | { name: 'library' }
  | { name: 'create' }
  | { name: 'guide'; id: string; editable: boolean; from: 'mine' | 'library' }
  | { name: 'dev' };

const SIGN_IN_ERRORS: Record<string, string> = {
  sign_in_timeout: 'Sign-in timed out. Please try again.',
};

function SignIn({
  auth,
  onSignedIn,
}: {
  auth: AuthStatus | null;
  onSignedIn: (a: AuthStatus | null) => void;
}) {
  const [waiting, setWaiting] = useState(false);
  const error = auth && !auth.signedIn ? auth.error : undefined;
  return (
    <div className="signin">
      <div className="signin-card">
        <div className="brand">Qhint</div>
        <p className="muted" style={{ marginTop: 0 }}>
          Step-by-step help, right on your screen.
        </p>
        <button
          className="btn primary"
          style={{ width: '100%', justifyContent: 'center', marginTop: 12 }}
          disabled={waiting}
          onClick={async () => {
            setWaiting(true);
            onSignedIn(await window.qhint.auth.signIn());
            setWaiting(false);
          }}
        >
          {waiting ? 'Finish signing in in your browser…' : 'Sign in with your work account'}
        </button>
        {error ? (
          <div className="notice error">
            {SIGN_IN_ERRORS[error] ?? 'Sign-in failed. Please try again.'}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function DevTools() {
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Developer</h1>
          <p className="sub">Only in development builds.</p>
        </div>
      </div>
      <div className="row">
        <button
          className="btn"
          onClick={async () => {
            setError(null);
            const r = await window.qhint.runSample('libreoffice-insert-table');
            if (r && !r.ok) setError(errorText(r.error));
          }}
        >
          Run sample guide: LibreOffice — insert a table
        </button>
        <button className="btn" onClick={async () => setSummary(await window.qhint.debugRings())}>
          Capture + draw rings
        </button>
        <button className="btn" onClick={() => void window.qhint.clearOverlay()}>
          Clear overlay
        </button>
      </div>
      {error ? <div className="notice error">{error}</div> : null}
      {summary ? <pre>{summary}</pre> : null}
    </>
  );
}

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [checked, setChecked] = useState(false);
  const [view, setView] = useState<View>({ name: 'mine' });
  const [mineCount, setMineCount] = useState<number | null>(null);

  useEffect(() => {
    void window.qhint.appInfo().then(setInfo);
    void window.qhint.auth.status().then((a) => {
      setAuth(a);
      setChecked(true);
    });
  }, []);

  const onCounts = useCallback((n: number) => setMineCount(n), []);

  if (!checked) return null;
  if (!auth?.signedIn) return <SignIn auth={auth} onSignedIn={setAuth} />;

  const nav = (
    name: 'mine' | 'library' | 'create' | 'dev',
    label: string,
    count?: number | null,
  ) => (
    <button
      className={`nav-item${view.name === name || (view.name === 'guide' && view.from === name) ? ' active' : ''}`}
      onClick={() => setView({ name } as View)}
    >
      {label}
      {count ? <span className="nav-count">{count}</span> : null}
    </button>
  );
  const open = (from: 'mine' | 'library') => (id: string, editable: boolean) =>
    setView({ name: 'guide', id, editable, from });

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">Qhint</div>
        {nav('mine', 'My guides', mineCount)}
        {nav('library', 'Company library')}
        {nav('create', '+ Create guide')}
        {info?.debugTools ? nav('dev', 'Developer') : null}
        <div className="sidebar-foot">
          <strong>{auth.tenantName}</strong>
          {auth.email ?? 'Signed in'}
          {info?.hotkey ? <div style={{ marginTop: 6 }}>Open Qhint: {info.hotkey}</div> : null}
          <button
            className="btn ghost small"
            style={{ marginTop: 8, marginLeft: -8 }}
            onClick={async () => setAuth(await window.qhint.auth.signOut())}
          >
            Sign out
          </button>
        </div>
      </aside>
      <main className="content">
        {view.name === 'mine' ? (
          <MyGuides
            onOpen={open('mine')}
            onCreate={() => setView({ name: 'create' })}
            onCounts={onCounts}
          />
        ) : view.name === 'library' ? (
          <Library onOpen={open('library')} />
        ) : view.name === 'create' ? (
          <CreateGuide onCreated={() => setView({ name: 'mine' })} />
        ) : view.name === 'guide' ? (
          <GuideEditor
            key={view.id}
            id={view.id}
            editable={view.editable}
            onBack={() => setView({ name: view.from } as View)}
            onDeleted={() => setView({ name: 'mine' })}
          />
        ) : (
          <DevTools />
        )}
      </main>
    </div>
  );
}
