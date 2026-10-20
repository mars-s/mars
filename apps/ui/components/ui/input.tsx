import * as React from "react"
import { cn } from "cn"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-[8px] border border-input bg-transparent px-3 text-base text-foreground transition-[border-color] duration-150 ease-[var(--ease-out)] pointer-coarse:h-11 md:text-sm",
        "placeholder:text-muted-foreground selection:bg-clay/35 hover:border-muted-foreground/60 focus-visible:border-ring",
        "file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive",
        className
      )}
      {...props}
    />
  )
}

export { Input }
