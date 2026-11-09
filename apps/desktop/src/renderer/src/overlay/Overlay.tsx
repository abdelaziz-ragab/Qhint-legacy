import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Rect } from '../../../shared/geometry';
import type {
  OverlayCard,
  OverlayGuide,
  OverlayRing,
  OverlayScene,
} from '../../../shared/overlay-scene';
import { placeCard } from '../../../shared/placement';

function rectStyle(r: Rect) {
  return { left: r.x, top: r.y, width: r.width, height: r.height };
}

function Ring({ ring }: { ring: OverlayRing }) {
  const pad = ring.pad ?? 4;
  const r = {
    x: ring.rect.x - pad,
    y: ring.rect.y - pad,
    width: ring.rect.width + 2 * pad,
    height: ring.rect.height + 2 * pad,
  };
  return <div className={`ring ring-${ring.tone ?? 'primary'}`} style={rectStyle(r)} />;
}

function Card({ card, workArea }: { card: OverlayCard; workArea: Rect }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const size = { width: el.offsetWidth, height: el.offsetHeight };
    const { rect } = placeCard(card.anchor, size, workArea);
    setPos({ left: rect.x, top: rect.y });
  }, [card, workArea]);

  return (
    <div
      ref={ref}
      className="card"
      style={pos ? { left: pos.left, top: pos.top } : { left: -10000, top: -10000 }}
    >
      <div className="card-title">{card.title}</div>
      {card.body ? <div className="card-body">{card.body}</div> : null}
    </div>
  );
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Pointer glides from where the mouse was to the target, then the ring/box appears. */
function Guide({ guide }: { guide: OverlayGuide }) {
  if (guide.kind === 'done') return <DoneMark rect={guide.rect} />;
  return <Pointer guide={guide} />;
}

/** Brief "that worked" confirmation on the element the user just used. */
function DoneMark({ rect }: { rect: OverlayGuide['rect'] }) {
  const pad = 5;
  return (
    <div
      className="ring ring-done"
      style={rectStyle({
        x: rect.x - pad,
        y: rect.y - pad,
        width: rect.width + 2 * pad,
        height: rect.height + 2 * pad,
      })}
    >
      <span className="done-badge" aria-hidden="true">
        ✓
      </span>
    </div>
  );
}

function Pointer({ guide }: { guide: OverlayGuide }) {
  const { rect } = guide;
  // Rest the pointer's tip on the target's lower-right corner so it never covers the label.
  const target = { x: rect.x + rect.width - 4, y: rect.y + rect.height - 4 };
  const from = guide.pointerFrom ?? target;
  // Remounted for every new target (keyed by guide.key), so initial state is the start position.
  const [pos, setPos] = useState(reducedMotion() ? target : from);
  const [arrived, setArrived] = useState(reducedMotion());

  useEffect(() => {
    if (arrived) return;
    // Next frame: move to the target so the CSS transition animates the glide.
    const raf = requestAnimationFrame(() => setPos(target));
    const done = setTimeout(() => setArrived(true), 650);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(done);
    };
    // Runs once per mount; a new target remounts the component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pad = 5;
  const box = {
    x: rect.x - pad,
    y: rect.y - pad,
    width: rect.width + 2 * pad,
    height: rect.height + 2 * pad,
  };
  return (
    <>
      {arrived ? (
        <div
          className={`ring ${guide.kind === 'type' ? 'ring-type' : 'ring-primary'}`}
          style={rectStyle(box)}
        >
          {guide.kind === 'type' && guide.text ? (
            <span className="type-label">Type: {guide.text}</span>
          ) : null}
        </div>
      ) : null}
      <svg
        className={`pointer${arrived ? ' arrived' : ''}`}
        // After the glide it stays on the target, even if the target moves (window dragged).
        style={arrived ? { left: target.x, top: target.y } : { left: pos.x, top: pos.y }}
        width="28"
        height="28"
        viewBox="0 0 28 28"
        aria-hidden="true"
      >
        <path d="M3 2 L3 22 L9 16.5 L13 25 L17 23.2 L13 14.8 L21 14.8 Z" />
      </svg>
    </>
  );
}

/** Where this page sits on screen (global DIP), kept current across window moves/resizes. */
function subscribeToWindowGeometry(onChange: () => void) {
  window.addEventListener('resize', onChange);
  return () => window.removeEventListener('resize', onChange);
}
const readPageOrigin = () => `${window.screenX},${window.screenY}`;

function usePageOrigin() {
  const [x, y] = useSyncExternalStore(subscribeToWindowGeometry, readPageOrigin)
    .split(',')
    .map(Number);
  return { x: x ?? 0, y: y ?? 0 };
}

export function Overlay() {
  const [scene, setScene] = useState<OverlayScene | null>(null);
  const page = usePageOrigin();

  useEffect(() => {
    window.qhintOverlay.onScene(setScene);
  }, []);

  if (!scene) return null;
  // Scene rects are relative to the display; shift by any gap between display and page origin.
  const offset = { left: scene.origin.x - page.x, top: scene.origin.y - page.y };
  return (
    <div className="stage" style={offset}>
      {scene.rings.map((ring, i) => (
        <Ring key={i} ring={ring} />
      ))}
      {scene.card ? <Card card={scene.card} workArea={scene.workArea} /> : null}
      {scene.guide ? <Guide key={scene.guide.key} guide={scene.guide} /> : null}
    </div>
  );
}
