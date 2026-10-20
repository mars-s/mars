"use client";

import type { ButtonHTMLAttributes } from "react";
import WarmTooltip from "@/components/react-bits/WarmTooltip";
import { cn } from "@/lib/utils";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  shortcut?: string;
  active?: boolean;
};

export function IconButton({ label, shortcut, active, className, children, ...props }: Props) {
  return (
    <WarmTooltip content={label} shortcut={shortcut} side="bottom">
      <button
        type="button"
        aria-label={label}
        aria-pressed={active === undefined ? undefined : active}
        className={cn("icon-button", active && "is-active", className)}
        {...props}
      >
        {children}
      </button>
    </WarmTooltip>
  );
}
