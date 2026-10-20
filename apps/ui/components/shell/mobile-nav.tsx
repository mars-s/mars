"use client";

import { MessageSquare, Plus, Settings, Wrench } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useWorkspace } from "@/components/workspace-context";
import { useChildNavigation } from "./child-navigation";

export function MobileNav() {
  const { snapshot, conversations, selectedId, pending, rootId, setExtensionsOpen, sidebarOpen, setSidebarOpen, safely, newConversation, selectConversation, openSettings } = useWorkspace();
  const childNavigation = useChildNavigation();
  return (
        <Dialog open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <DialogContent className="live-mobile-nav" placement="left">
            <DialogHeader>
              <DialogTitle>Mars workspace</DialogTitle>
              <DialogDescription>Your conversations and installed extensions.</DialogDescription>
            </DialogHeader>
            <nav>
              <button
                type="button"
                className="live-nav"
                disabled={pending || !snapshot}
                onClick={() => safely(newConversation())}
              >
                <Plus size={16} />
                New chat
              </button>
              {conversations.map((conversation) => (
                <div key={conversation.id}>
                  <button
                    type="button"
                    className="live-nav"
                    key={conversation.id}
                    aria-current={selectedId === conversation.id ? "page" : undefined}
                    onClick={() => selectConversation(conversation.id)}
                  >
                    <MessageSquare size={16} />
                    <span>{conversation.title}</span>
                  </button>
                  {conversation.id === rootId && childNavigation}
                </div>
              ))}

              <button
                type="button"
                className="live-nav"
                onClick={() => {
                  setExtensionsOpen(false);
                  setSidebarOpen(false);
                }}
              >
                <MessageSquare size={16} />
                Conversation
              </button>
              <button
                type="button"
                className="live-nav"
                onClick={() => {
                  setExtensionsOpen(true);
                  setSidebarOpen(false);
                }}
              >
                <Wrench size={16} />
                Extensions
              </button>
              <button type="button" className="live-nav" onClick={() => openSettings()}>
                <Settings size={16} />
                Settings
              </button>
            </nav>
          </DialogContent>
        </Dialog>
  );
}
