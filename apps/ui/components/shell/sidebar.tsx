"use client";

import { MessageSquare, Plus, Settings, Wrench, X } from "lucide-react";
import { MarsMark } from "@/components/mars-mark";
import { useWorkspace } from "@/components/workspace-context";
import { useChildNavigation } from "./child-navigation";
import "./shell.css";

export function Sidebar() {
  const { snapshot, conversations, selectedId, pending, canChat, connected, rootId, extensionsOpen, setExtensionsOpen, setSidebarOpen, safely, newConversation, selectConversation, openSettings } = useWorkspace();
  const childNavigation = useChildNavigation();
  return (
          <aside className="live-sidebar" aria-label="Workspace navigation">
            <div className="live-brand">
              <a href="/" aria-label="Mars home">
                <MarsMark width={25} height={25} />
                <span>Mars</span>
              </a>
              <button
                type="button"
                className="live-icon live-mobile-close"
                aria-label="Close navigation"
                onClick={() => setSidebarOpen(false)}
              >
                <X size={18} />
              </button>
            </div>
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
              <button
                type="button"
                className={`live-nav ${!extensionsOpen ? "live-nav-selected" : ""}`}
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
                className={`live-nav ${extensionsOpen ? "live-nav-selected" : ""}`}
                onClick={() => {
                  setExtensionsOpen(true);
                  setSidebarOpen(false);
                }}
              >
                <Wrench size={16} />
                Extensions
                {snapshot && snapshot.extensions.length > 0 && (
                  <span className="live-count">{snapshot.extensions.length}</span>
                )}
              </button>
            </nav>
            <div className="live-sidebar-history">
              <p>Conversations</p>
              {conversations.map((conversation) => (
                <div key={conversation.id}>
                  <button
                    type="button"
                    className="live-nav"
                    aria-current={selectedId === conversation.id ? "page" : undefined}
                    onClick={() => selectConversation(conversation.id)}
                  >
                    <MessageSquare size={14} />
                    <span>{conversation.title}</span>
                    {conversation.running && (
                      <span className="live-conversation-running" aria-label="Running" />
                    )}
                  </button>
                  {conversation.id === rootId && childNavigation}
                </div>
              ))}
            </div>
            <button type="button" className="live-settings-button" onClick={() => openSettings()}>
              <Settings size={16} />
              <span>Settings</span>
              <span
                className={`live-connection-dot ${canChat ? "is-connected" : ""}`}
                aria-label={canChat ? "Model available" : "Model not connected"}
              />
            </button>
          </aside>
  );
}
