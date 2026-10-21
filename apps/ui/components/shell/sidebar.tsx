"use client";

import { useEffect, useState } from "react";
import { SidebarContent } from "./sidebar-content";
import { useSidebarCollapsed } from "./sidebar-collapse";
import "./shell.css";

export function Sidebar() {
  const collapsed = useSidebarCollapsed();
  // The saved width applies after hydration; animate only changes made after that.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setSettled(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <aside
      className="live-sidebar"
      aria-label="Workspace navigation"
      data-collapsed={collapsed || undefined}
      data-settled={settled || undefined}
    >
      <SidebarContent collapsed={collapsed} />
    </aside>
  );
}
