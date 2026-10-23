"use client";

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { SidebarContent } from "./sidebar-content";
import { useSidebarCollapsed } from "./sidebar-collapse";
import { SIDEBAR_WIDTH, clampSidebarWidth, setSidebarWidth, useSidebarWidth } from "./sidebar-width";
import "./shell.css";

export function Sidebar() {
  const collapsed = useSidebarCollapsed();
  const saved = useSidebarWidth();
  // While dragging, the width follows the pointer without writing storage on every move.
  const [dragging, setDragging] = useState<number | null>(null);
  const start = useRef({ x: 0, width: 0 });
  // The saved width applies after hydration; animate only changes made after that.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setSettled(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const width = dragging ?? saved;

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = { x: event.clientX, width: saved };
    setDragging(saved);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragging === null) return;
    setDragging(clampSidebarWidth(start.current.width + event.clientX - start.current.x));
  };
  const finish = () => {
    if (dragging === null) return;
    setSidebarWidth(dragging);
    setDragging(null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const by = event.shiftKey ? SIDEBAR_WIDTH.step * 4 : SIDEBAR_WIDTH.step;
    const next =
      event.key === "ArrowLeft" ? saved - by
      : event.key === "ArrowRight" ? saved + by
      : event.key === "Home" ? SIDEBAR_WIDTH.min
      : event.key === "End" ? SIDEBAR_WIDTH.max
      : event.key === "Enter" ? SIDEBAR_WIDTH.initial
      : null;
    if (next === null) return;
    event.preventDefault();
    setSidebarWidth(next);
  };

  return (
    <aside
      className="live-sidebar"
      aria-label="Workspace navigation"
      data-collapsed={collapsed || undefined}
      data-settled={settled || undefined}
      data-resizing={dragging !== null || undefined}
      style={{ "--live-sidebar-width": `${width}px` } as CSSProperties}
    >
      <SidebarContent collapsed={collapsed} />
      {!collapsed && (
        <div
          className="live-sidebar-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuemin={SIDEBAR_WIDTH.min}
          aria-valuemax={SIDEBAR_WIDTH.max}
          aria-valuenow={width}
          title="Drag to resize. Double-click to reset."
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finish}
          onPointerCancel={finish}
          onLostPointerCapture={finish}
          onDoubleClick={() => setSidebarWidth(SIDEBAR_WIDTH.initial)}
          onKeyDown={onKeyDown}
        />
      )}
    </aside>
  );
}
