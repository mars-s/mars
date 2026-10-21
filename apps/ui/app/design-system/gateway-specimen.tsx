"use client";

import { useSyncExternalStore } from "react";
import { GatewaySettings } from "@/components/settings/gateway-settings";
import { ChannelMark } from "@/components/shell/channel-mark";
import { installSampleHost } from "./sample-host";

let installed = false;
const subscribe = () => {
  if (!installed && typeof window !== "undefined") {
    installed = true;
    installSampleHost();
  }
  return () => {};
};

/** Gateway specimens with sample data: the Recents channel mark and Settings, Gateway. */
export function GatewaySpecimen() {
  const ready = useSyncExternalStore(subscribe, () => installed, () => false);
  return (
    <div className="ds-gateway">
      <div className="ds-gateway-recents" aria-label="Recents sample">
        {[["Tidy the Pi host deploy script", ""], ["Weekly reading list", "telegram"], ["Ask about the build", "discord"], ["Nightly report", "api"]].map(([title, channel]) => (
          <div key={title} className="live-nav live-conversation">
            <span className="live-nav-label">{title}</span>
            {channel && <ChannelMark channel={channel} label />}
          </div>
        ))}
      </div>
      <div className="ds-gateway-settings">{ready && <GatewaySettings />}</div>
    </div>
  );
}
