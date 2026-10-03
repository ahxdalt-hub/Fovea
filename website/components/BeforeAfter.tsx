'use client';

import { useCallback, useRef, useState } from 'react';

/**
 * Before / after comparison. The raw (small) original sits underneath; the
 * 4× enhanced result is layered on top and clipped to a split position.
 * Drag anywhere, use the arrow keys, or move the visible range handle —
 * all three drive the same `--split` percentage the CSS clips and centers
 * the divider on. Rendered server-side at 50% so it looks right before JS.
 */
export function BeforeAfter({
  before,
  after,
  beforeAlt,
  afterAlt,
  aspect = '3 / 2',
}: {
  before: string;
  after: string;
  beforeAlt: string;
  afterAlt: string;
  aspect?: string;
}) {
  const [split, setSplit] = useState(50);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);

  const setFromClientX = useCallback((clientX: number) => {
    const frame = frameRef.current;
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    if (rect.width === 0) return;
    const pct = ((clientX - rect.left) / rect.width) * 100;
    setSplit(Math.max(0, Math.min(100, pct)));
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    setFromClientX(e.clientX);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragging.current) setFromClientX(e.clientX);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft') setSplit((s) => Math.max(0, s - 2));
    else if (e.key === 'ArrowRight') setSplit((s) => Math.min(100, s + 2));
    else if (e.key === 'Home') setSplit(0);
    else if (e.key === 'End') setSplit(100);
  };

  const style = { ['--split' as string]: `${split}%` } as React.CSSProperties;

  return (
    <div
      ref={frameRef}
      className="ba-frame"
      style={{ ...style, aspectRatio: aspect }}
      role="slider"
      tabIndex={0}
      aria-label="Before and after comparison"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(split)}
      aria-orientation="horizontal"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={onKeyDown}
    >
      {/* Underneath: the original. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={before} alt={beforeAlt} className="ba-layer" draggable={false} />
      {/* On top: the enhanced result, clipped to the split. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={after}
        alt={afterAlt}
        className="ba-layer ba-after"
        style={style}
        draggable={false}
      />

      <div className="ba-divider" style={style} />
      <div className="ba-handle" style={style} aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M9 6 4 12l5 6M15 6l5 6-5 6"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>

      <span className="ba-tag" style={{ left: 14 }}>
        Before
      </span>
      <span className="ba-tag" style={{ right: 14 }}>
        After · 4×
      </span>
    </div>
  );
}
