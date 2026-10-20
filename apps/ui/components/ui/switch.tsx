"use client"

import * as React from "react"
import { cn } from "cn"
import { Switch as SwitchPrimitive } from "radix-ui"

// The ::before box widens the hit area to about 44px without changing layout.
function Switch({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "default"
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "peer group/switch relative inline-flex shrink-0 items-center rounded-full p-0.5 transition-colors duration-150 ease-[var(--ease-out)] before:absolute before:-inset-x-1.5 before:-inset-y-3 before:content-[''] disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-5 data-[size=default]:w-9 data-[size=sm]:h-4 data-[size=sm]:w-7 data-[state=checked]:bg-foreground data-[state=unchecked]:bg-input",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block rounded-full transition-[translate,background-color] duration-150 ease-[var(--ease-out)] group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 data-[state=checked]:translate-x-full data-[state=checked]:bg-background data-[state=unchecked]:translate-x-0 data-[state=unchecked]:bg-muted-foreground"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
