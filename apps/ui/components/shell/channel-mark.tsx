import { Globe, MessageCircle, Send, type LucideIcon } from "lucide-react";
import { channelName } from "@/lib/pi/gateway";
import "./shell.css";

const ICONS: Record<string, LucideIcon> = { telegram: Send, discord: MessageCircle, api: Globe };

/** Small mark for the chat app a conversation came from (docs/GATEWAY.md). Decorative unless `label`. */
export function ChannelMark({ channel, label = false }: { channel: string; label?: boolean }) {
  const Icon = ICONS[channel] ?? Globe;
  return (
    <span className="live-channel-mark" data-channel={channel} title={channelName(channel)}>
      <Icon size={12} aria-hidden="true" />
      {label ? <span className="sr-only">From {channelName(channel)}</span> : null}
    </span>
  );
}
