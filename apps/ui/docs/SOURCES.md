# Sources and provenance

Reviewed 20 October 2026.

## Primary design source

The owner privately supplied 46 reference screenshots with indexes and thumbnails. That personal archive stays outside the public repository. DESIGN.md captures the direction; the running UI does not import screenshot content.

## Framework and component sources

- Next.js App Router documentation, including the docs bundled with the installed Next.js package: https://nextjs.org/docs/app
- assistant-ui Claude example: https://www.assistant-ui.com/examples/claude
- assistant-ui External Store Runtime: https://www.assistant-ui.com/docs/runtimes/custom/external-store
- assistant-ui primitives: https://www.assistant-ui.com/docs/primitives/thread
- assistant-ui Markdown element: https://www.assistant-ui.com/elements/markdown-text
- shadcn Next.js installation: https://ui.shadcn.com/docs/installation/next
- shadcn source and license: https://github.com/shadcn-ui/ui
- React Bits Micro Interactions: https://reactbits.dev/c/micro
- React Bits Status Mark: https://reactbits.dev/micro/status-mark
- React Bits Warm Tooltip: https://reactbits.dev/micro/warm-tooltip
- React Bits source: https://github.com/DavidHDev/react-bits
- Lucide: https://lucide.dev/

`components/ui/` was generated using the shadcn registry, then composed with the Mars styles. `components/react-bits/` retains verified upstream component APIs, restrained defaults, attribution and reduced-motion behavior. Warm Tooltip also includes a guard for server rendering in Next.js.

The shadcn source notice is retained in `licenses/shadcn.txt` from https://raw.githubusercontent.com/shadcn-ui/ui/main/LICENSE.md.

The React Bits component source was retrieved at commit `e12c22192ac7b4b452c5e2feb9b586d74765d696`. Its complete MIT + Commons Clause license is retained in `licenses/react-bits.txt`. These components are part of the Mars application, not distributed as a standalone component collection.

## Secondary design reference

The publicly available Claude `DESIGN.md` was retrieved through `npx getdesign@latest add claude` and reviewed:

- https://getdesign.md/claude/design-md
- https://getdesign.md/design-md/claude/preview
- https://github.com/VoltAgent/awesome-claude-design

This is an independent design analysis, not an official Anthropic design system. No exact user-supplied Claude Markdown file was present in the screenshot archive. The public analysis is therefore treated as the likely secondary reference, with the supplied screenshots taking precedence. Its full marketing analysis is not bundled as the project's governing design document; the authored `DESIGN.md` describes the actual screenshot-led implementation.

## Runtime integration references

- Pi repository: https://github.com/earendil-works/pi
- Pi Durable README: https://github.com/earendil-works/pi/blob/main/packages/durable/README.md
- Tailscale Serve: https://tailscale.com/docs/features/tailscale-serve

These inform the handoff guide. The imported ZIP supplied only the client and an adapter proposal. The live client connects to the Pi host in `packages/pi-host` in this monorepo. These public documents do not establish the trial host's custom HTTP endpoints or extension UI contract; use the local implementation and verification record for those.

## Public research for the live Pi client

Verified 20 October 2026 from public pages. No Claude account pages were accessed, and no blog archive or proprietary UI source was copied.

| Primary source | Finding and use |
| --- | --- |
| [assistant-ui Claude example](https://www.assistant-ui.com/examples/claude) | Demonstrates a flat bordered composer, a quieter conversation canvas and message actions shown on hover or keyboard focus. Its warm cream theme and broad serif usage are example choices; the supplied dark app screenshots remain the Mars visual authority. |
| [assistant-ui External Store Runtime](https://www.assistant-ui.com/docs/runtimes/custom/external-store) | The application supplies message state and callbacks. Expose editing, regeneration or branching only when the corresponding backend operation exists. Keep Pi as the source of persisted state. |
| [Introducing Claude Design by Anthropic Labs](https://www.anthropic.com/news/claude-design-anthropic-labs), 17 April 2026 | Describes importing an existing design system and refining work through conversation and direct controls. Our interpretation is to preserve the ZIP's established Mars components and tokens while connecting real data. This article is not an official Claude app design-token specification. |
| [Claude Design now stays on brand for daily work](https://claude.com/resources/articles/claude-design-stays-on-brand-for-daily-work), 17 June 2026, updated September 2026 | Describes reusing existing components and checking output against the design system. It supports keeping one documented Mars system across agent-generated UI changes; it does not establish feature availability in this trial. |
| [React Bits Status Mark](https://reactbits.dev/micro/status-mark) and [Warm Tooltip](https://reactbits.dev/micro/warm-tooltip) | Official component pages corroborate the micro-interaction choices already supplied in the ZIP. See the pinned source links and adaptations in `components/react-bits/README.md`. |
| [Emil Kowalski's animation course](https://animations.dev/) | The installed Emil skill supplies the applied guidance: animate to explain a state change, keep frequently repeated controls quick, and respect reduced motion. Website references are background, not proof of implementation or a dependency. |

The independent getdesign analysis above remains optional background. It does not outrank the user's screenshot or measured application styles. The Mars mark and name remain the application's own identity.
