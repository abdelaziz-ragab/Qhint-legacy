import { useEffect, useState } from 'react';
import type { AppInfo } from '../../shared/ipc';

const styles = {
  page: {
    fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    padding: 24,
    color: '#1d2433',
  },
  muted: { color: '#5b6478', fontSize: 13 },
  row: { display: 'flex', gap: 8, margin: '16px 0' },
  button: {
    font: 'inherit',
    padding: '8px 12px',
    borderRadius: 8,
    border: '1px solid #ccd2dc',
    background: '#fff',
    cursor: 'pointer',
  },
  pre: {
    fontSize: 12,
    background: '#f4f5f7',
    padding: 12,
    borderRadius: 8,
    whiteSpace: 'pre-wrap',
  },
} as const;

export function App() {
  const { platform, versions } = window.qhint;
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);

  useEffect(() => {
    void window.qhint.appInfo().then(setInfo);
  }, []);

  const runDebug = async () => {
    setBusy(true);
    try {
      setSummary(await window.qhint.debugRings());
    } finally {
      setBusy(false);
    }
  };

  return (
    <main style={styles.page}>
      <h1>Qhint</h1>
      <p style={styles.muted}>
        Hotkey: {info?.hotkey ?? 'unavailable'}
        {info?.hotkeyIsFallback ? ' (fallback; default was taken)' : ''}
      </p>
      <div style={styles.row}>
        <button style={styles.button} disabled={busy} onClick={() => void runDebug()}>
          {busy ? 'Capturing…' : 'Debug: capture + draw rings'}
        </button>
        <button style={styles.button} onClick={() => void window.qhint.clearOverlay()}>
          Clear overlay
        </button>
      </div>
      {summary ? <pre style={styles.pre}>{summary}</pre> : null}
      <p style={styles.muted}>
        {platform} · Electron {versions.electron} · Chrome {versions.chrome}
      </p>
    </main>
  );
}
