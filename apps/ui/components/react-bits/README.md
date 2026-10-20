# React Bits micro interactions

These components are adapted from [DavidHDev/react-bits](https://github.com/DavidHDev/react-bits) at commit `e12c22192ac7b4b452c5e2feb9b586d74765d696` (retrieved 20 October 2026).

## Source and licence

- [StatusMark](https://github.com/DavidHDev/react-bits/blob/e12c22192ac7b4b452c5e2feb9b586d74765d696/src/ts-tailwind/Micro/StatusMark/StatusMark.tsx)
- [WarmTooltip](https://github.com/DavidHDev/react-bits/blob/e12c22192ac7b4b452c5e2feb9b586d74765d696/src/ts-tailwind/Micro/WarmTooltip/WarmTooltip.tsx)
- The complete upstream **MIT + Commons Clause** licence is retained in [licenses/react-bits.txt](../../licenses/react-bits.txt).

The component APIs are unchanged. Both are client components and require `motion`, React and React DOM. Tailwind scans their static class names from this directory.

Both components use Motion's `useReducedMotionConfig` hook so they respect the system preference and the workspace's `MotionConfig reducedMotion="always"` setting.

## Mars adaptations

StatusMark uses a 14px glyph, 1.6px stroke, muted success/error colours, a 180ms check animation, no fill and no label strike-through by default. Its reduced-motion state is static rather than continually pulsing; the upstream reduced-motion and accessible status text logic are retained.

WarmTooltip uses a warm charcoal surface, warm white text, a 6px radius, no arrow, 160ms group travel and a restrained 120ms pop without blur. The upstream keyboard, touch, portal positioning and reduced-motion handling are retained. Its Motion layout transform guards access to `window` during Next.js server rendering; viewport coordinates are measured on the client when a tooltip opens.

## Imports

```tsx
import StatusMark from "@/components/react-bits/StatusMark";
import WarmTooltip, { WarmTooltipGroup } from "@/components/react-bits/WarmTooltip";

<StatusMark status="running" label="Reading sources" />

<WarmTooltipGroup>
  <WarmTooltip content="Attach files" shortcut="⌘U">
    <button aria-label="Attach files">Attach</button>
  </WarmTooltip>
</WarmTooltipGroup>
```

StatusMark states are `pending`, `running`, `done`, `failed` and `cancelled`; `progress` is a fraction from 0 to 1 when known. Omit it for an indeterminate running indicator. Status and progress must come from the application runtime.

WarmTooltip also works without a group, creating a standalone group internally. Use a shared WarmTooltipGroup around related controls so the initial tooltip waits 400ms and neighbouring tooltips open immediately while the group remains warm. Keep an accessible name on every icon-only button.

