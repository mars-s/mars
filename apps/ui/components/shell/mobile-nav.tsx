"use client";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useWorkspace } from "@/components/workspace-context";
import { SidebarContent } from "./sidebar-content";
import "./shell.css";

export function MobileNav() {
  const { sidebarOpen, setSidebarOpen } = useWorkspace();
  return (
    <Dialog open={sidebarOpen} onOpenChange={setSidebarOpen}>
      <DialogContent
        className="live-mobile-nav"
        placement="left"
        showCloseButton={false}
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">Navigation</DialogTitle>
        <SidebarContent drawer />
      </DialogContent>
    </Dialog>
  );
}
