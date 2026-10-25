"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Minus, Plus, X } from "lucide-react";
import "./image-viewer.css";

const MIN = 1;
const MAX = 8;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

type View = { scale: number; x: number; y: number };
const FIT: View = { scale: 1, x: 0, y: 0 };

/** Wraps a thumbnail so a click opens the image in an overlay over the chat, never a new tab. */
export function ImageViewerTrigger({ src, alt, label, children }: { src: string; alt: string; label?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="mars-image-trigger" onClick={() => setOpen(true)} aria-label={`View ${label || alt}`}>
        {children}
      </button>
      {open && <ImageViewer src={src} alt={alt} label={label} onClose={() => setOpen(false)} />}
    </>
  );
}

function ImageViewer({ src, alt, label, onClose }: { src: string; alt: string; label?: string; onClose: () => void }) {
  const [view, setView] = useState<View>(FIT);
  const [closing, setClosing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<number | null>(null);

  const close = useCallback(() => setClosing(true), []);
  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(onClose, 180);
    return () => clearTimeout(timer);
  }, [closing, onClose]);

  // Zoom toward a point (stage coordinates from its centre) so what is under the cursor stays put.
  const zoomAt = useCallback((factor: number, px = 0, py = 0) => {
    setView((v) => {
      const scale = clamp(v.scale * factor, MIN, MAX);
      if (scale === MIN) return FIT;
      const k = scale / v.scale;
      return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
    });
  }, []);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    stage.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
      else if (event.key === "+" || event.key === "=") zoomAt(1.4);
      else if (event.key === "-") zoomAt(1 / 1.4);
      else if (event.key === "0") setView(FIT);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, [close, zoomAt]);

  // Wheel and trackpad pinch (ctrlKey) zoom; registered natively so preventDefault works.
  useEffect(() => {
    const node = stage.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      const px = event.clientX - rect.left - rect.width / 2;
      const py = event.clientY - rect.top - rect.height / 2;
      zoomAt(Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0025)), px, py);
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const point = (event: React.PointerEvent) => {
    const rect = stage.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 };
  };

  const onPointerDown = (event: React.PointerEvent) => {
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, moved: false };
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = Math.hypot(a.x - b.x, a.y - b.y);
    }
  };
  const onPointerMove = (event: React.PointerEvent) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      zoomAt(distance / pinch.current);
      pinch.current = distance;
      if (drag.current) drag.current.moved = true;
      return;
    }
    const start = drag.current;
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (!start.moved && Math.hypot(dx, dy) < 4) return;
    setDragging(true);
    drag.current = { x: event.clientX, y: event.clientY, moved: true };
    setView((v) => (v.scale === 1 ? v : { ...v, x: v.x + dx, y: v.y + dy }));
  };
  const onPointerUp = (event: React.PointerEvent) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    const start = drag.current;
    drag.current = null;
    setDragging(false);
    // A plain click on the backdrop closes; a click on the image toggles zoom.
    if (start && !start.moved && pointers.current.size === 0) {
      const onImage = (event.target as HTMLElement).tagName === "IMG";
      if (!onImage) close();
      else if (view.scale > 1) setView(FIT);
      else {
        const p = point(event);
        zoomAt(2.5, p.x, p.y);
      }
    }
  };

  return createPortal(
    <div className="mars-image-viewer" data-closing={closing || undefined} role="dialog" aria-modal="true" aria-label={label || alt}>
      <div
        ref={stage}
        tabIndex={-1}
        className="mars-image-viewer-stage"
        data-zoomed={view.scale > 1 || undefined}
        data-dragging={dragging || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          style={{ transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})` }}
        />
      </div>
      <div className="mars-image-viewer-bar">
        {label && <span className="mars-image-viewer-label">{label}</span>}
        <button type="button" onClick={() => zoomAt(1 / 1.4)} disabled={view.scale <= MIN} aria-label="Zoom out">
          <Minus size={15} aria-hidden />
        </button>
        <button type="button" className="mars-image-viewer-scale" onClick={() => setView(FIT)} aria-label="Fit to screen">
          {Math.round(view.scale * 100)}%
        </button>
        <button type="button" onClick={() => zoomAt(1.4)} disabled={view.scale >= MAX} aria-label="Zoom in">
          <Plus size={15} aria-hidden />
        </button>
        <button type="button" onClick={close} aria-label="Close">
          <X size={15} aria-hidden />
        </button>
      </div>
    </div>,
    document.body,
  );
}
