const styles = {
  page: {
    fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    padding: 24,
    color: '#1d2433',
  },
  muted: { color: '#5b6478', fontSize: 13 },
} as const;

export function App() {
  const { platform, versions } = window.qhint;
  return (
    <main style={styles.page}>
      <h1>Qhint</h1>
      <p>Desktop shell is running.</p>
      <p style={styles.muted}>
        {platform} · Electron {versions.electron} · Chrome {versions.chrome}
      </p>
    </main>
  );
}
