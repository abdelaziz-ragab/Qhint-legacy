import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Rect } from '../../../shared/geometry';
import type { OverlayCard, OverlayRing, OverlayScene } from '../../../shared/overlay-scene';
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

export function Overlay() {
  const [scene, setScene] = useState<OverlayScene | null>(null);

  useEffect(() => {
    window.qhintOverlay.onScene(setScene);
  }, []);

  if (!scene) return null;
  return (
    <>
      {scene.rings.map((ring, i) => (
        <Ring key={i} ring={ring} />
      ))}
      {scene.card ? <Card card={scene.card} workArea={scene.workArea} /> : null}
    </>
  );
}
