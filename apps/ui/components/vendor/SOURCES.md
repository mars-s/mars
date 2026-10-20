# Vendored component register

Retrieved 2026-10-20 by scripts/vendor-components.mjs. Hashes are of the upstream file before import-path rewriting.
Upgrade by rerunning the script, then scripts/theme-vendor.mjs, and reviewing the diff. Full licence texts are in licenses/.
Local changes after import: palette classes mapped to Mars tokens (theme-vendor.mjs); agent-ui.css variables point at Mars tokens;
edit-tool.tsx follows data-theme and uses --surface instead of forced black. Mars wrappers live outside components/vendor.

| Source | Licence |
| --- | --- |
| kokonut | MIT, Copyright (c) 2025 kokonutUI (github.com/kokonut-labs/kokonutui) |
| agent-elements | MIT, Copyright (c) 2026 21st.dev (github.com/21st-dev/agent-elements) |
| assistant-ui | MIT, Copyright (c) 2026 AgentbaseAI Inc. (github.com/assistant-ui/assistant-ui) |
| ai-elements | Apache-2.0, Copyright 2023 Vercel, Inc. (github.com/vercel/ai-elements) |

| Source | Item | File | SHA-256 |
| --- | --- | --- | --- |
| kokonut | [ai-prompt](https://kokonutui.com/r/ai-prompt.json) | components/vendor/kokonut/ai-prompt.tsx | cf773bf3bd08bb47 |
| kokonut | [ai-prompt](https://kokonutui.com/r/ai-prompt.json) | components/vendor/kokonut/hooks/use-auto-resize-textarea.ts | 2f63a48ded800f00 |
| kokonut | [ai-model-selector](https://kokonutui.com/r/ai-model-selector.json) | components/vendor/kokonut/ai-model-selector.tsx | a1d4d38a68f389a9 |
| kokonut | [ai-context-meter](https://kokonutui.com/r/ai-context-meter.json) | components/vendor/kokonut/ai-context-meter.tsx | 550b123c69f5727e |
| kokonut | [ai-tool-approval](https://kokonutui.com/r/ai-tool-approval.json) | components/vendor/kokonut/ai-tool-approval.tsx | 3cb3c7bde2672b6d |
| kokonut | [ai-diff-review](https://kokonutui.com/r/ai-diff-review.json) | components/vendor/kokonut/ai-diff-review.tsx | 58816595134c98d8 |
| kokonut | [ai-citations](https://kokonutui.com/r/ai-citations.json) | components/vendor/kokonut/ai-citations.tsx | 4b9f231346eab294 |
| kokonut | [ai-loading](https://kokonutui.com/r/ai-loading.json) | components/vendor/kokonut/ai-loading.tsx | 463423c5f1edb88c |
| kokonut | [ai-text-loading](https://kokonutui.com/r/ai-text-loading.json) | components/vendor/kokonut/ai-text-loading.tsx | 2d4292ea41831671 |
| kokonut | [ai-voice](https://kokonutui.com/r/ai-voice.json) | components/vendor/kokonut/ai-voice.tsx | bce31686dd91f9de |
| kokonut | [file-upload](https://kokonutui.com/r/file-upload.json) | components/vendor/kokonut/file-upload.tsx | 33927be824282977 |
| kokonut | [action-search-bar](https://kokonutui.com/r/action-search-bar.json) | components/vendor/kokonut/action-search-bar.tsx | 657c92cf00dca08a |
| kokonut | [status-island](https://kokonutui.com/r/status-island.json) | components/vendor/kokonut/status-island.tsx | 6e4001d778d5b402 |
| agent-elements | [edit-tool](https://agent-elements.21st.dev/r/edit-tool.json) | components/vendor/agent-elements/tools/edit-tool.tsx | 8f16b3e2843416f7 |
| agent-elements | [edit-tool](https://agent-elements.21st.dev/r/edit-tool.json) | components/vendor/agent-elements/types/timeline.ts | 473a2eee0935a709 |
| agent-elements | [edit-tool](https://agent-elements.21st.dev/r/edit-tool.json) | components/vendor/agent-elements/hooks/use-tool-complete.ts | 8ebcacc22b933095 |
| agent-elements | [edit-tool](https://agent-elements.21st.dev/r/edit-tool.json) | components/vendor/agent-elements/icons/file-ext-icon.tsx | 4c4307b54c03c6ec |
| agent-elements | [edit-tool](https://agent-elements.21st.dev/r/edit-tool.json) | components/vendor/agent-elements/utils/tool-adapters.ts | 1f3a748c20aed59d |
| agent-elements | [edit-tool](https://agent-elements.21st.dev/r/edit-tool.json) | components/vendor/agent-elements/tools/tool-approval-footer.tsx | 8f8cdd2d50196246 |
| agent-elements | [edit-tool](https://agent-elements.21st.dev/r/edit-tool.json) | components/vendor/agent-elements/utils/cn.ts | d1f1e0d62cb8d8d1 |
| agent-elements | [edit-tool](https://agent-elements.21st.dev/r/edit-tool.json) | components/vendor/agent-elements/agent-ui.css | 20817c261c1ff7fc |
| agent-elements | [text-shimmer](https://agent-elements.21st.dev/r/text-shimmer.json) | components/vendor/agent-elements/text-shimmer.tsx | 70d6753e15afbdc9 |
| agent-elements | [text-shimmer](https://agent-elements.21st.dev/r/text-shimmer.json) | components/vendor/agent-elements/utils/cn.ts | d1f1e0d62cb8d8d1 |
| agent-elements | [text-shimmer](https://agent-elements.21st.dev/r/text-shimmer.json) | components/vendor/agent-elements/agent-ui.css | 20817c261c1ff7fc |
| agent-elements | [bash-tool](https://agent-elements.21st.dev/r/bash-tool.json) | components/vendor/agent-elements/tools/bash-tool.tsx | 37b761d3edda9cdc |
| agent-elements | [bash-tool](https://agent-elements.21st.dev/r/bash-tool.json) | components/vendor/agent-elements/types/timeline.ts | 473a2eee0935a709 |
| agent-elements | [bash-tool](https://agent-elements.21st.dev/r/bash-tool.json) | components/vendor/agent-elements/hooks/use-tool-complete.ts | 8ebcacc22b933095 |
| agent-elements | [bash-tool](https://agent-elements.21st.dev/r/bash-tool.json) | components/vendor/agent-elements/utils/tool-adapters.ts | 1f3a748c20aed59d |
| agent-elements | [bash-tool](https://agent-elements.21st.dev/r/bash-tool.json) | components/vendor/agent-elements/tools/tool-approval-footer.tsx | 8f8cdd2d50196246 |
| agent-elements | [bash-tool](https://agent-elements.21st.dev/r/bash-tool.json) | components/vendor/agent-elements/utils/cn.ts | d1f1e0d62cb8d8d1 |
| agent-elements | [bash-tool](https://agent-elements.21st.dev/r/bash-tool.json) | components/vendor/agent-elements/agent-ui.css | 20817c261c1ff7fc |
| agent-elements | [search-tool](https://agent-elements.21st.dev/r/search-tool.json) | components/vendor/agent-elements/tools/search-tool.tsx | 9fa74a146b7e1a0c |
| agent-elements | [search-tool](https://agent-elements.21st.dev/r/search-tool.json) | components/vendor/agent-elements/types/timeline.ts | 473a2eee0935a709 |
| agent-elements | [search-tool](https://agent-elements.21st.dev/r/search-tool.json) | components/vendor/agent-elements/icons/source-icons.ts | 1606ce1c3626d8d6 |
| agent-elements | [search-tool](https://agent-elements.21st.dev/r/search-tool.json) | components/vendor/agent-elements/tools/tool-row-base.tsx | f049928325d2a323 |
| agent-elements | [search-tool](https://agent-elements.21st.dev/r/search-tool.json) | components/vendor/agent-elements/hooks/use-tool-complete.ts | 8ebcacc22b933095 |
| agent-elements | [search-tool](https://agent-elements.21st.dev/r/search-tool.json) | components/vendor/agent-elements/utils/tool-adapters.ts | 1f3a748c20aed59d |
| agent-elements | [search-tool](https://agent-elements.21st.dev/r/search-tool.json) | components/vendor/agent-elements/utils/cn.ts | d1f1e0d62cb8d8d1 |
| agent-elements | [search-tool](https://agent-elements.21st.dev/r/search-tool.json) | components/vendor/agent-elements/agent-ui.css | 20817c261c1ff7fc |
| agent-elements | [plan-tool](https://agent-elements.21st.dev/r/plan-tool.json) | components/vendor/agent-elements/tools/plan-tool.tsx | 81565457066c7c5c |
| agent-elements | [plan-tool](https://agent-elements.21st.dev/r/plan-tool.json) | components/vendor/agent-elements/icons.tsx | 5deb63b538acb935 |
| agent-elements | [plan-tool](https://agent-elements.21st.dev/r/plan-tool.json) | components/vendor/agent-elements/utils/format-tool.ts | f65ef6ca21693684 |
| agent-elements | [plan-tool](https://agent-elements.21st.dev/r/plan-tool.json) | components/vendor/agent-elements/utils/cn.ts | d1f1e0d62cb8d8d1 |
| agent-elements | [plan-tool](https://agent-elements.21st.dev/r/plan-tool.json) | components/vendor/agent-elements/agent-ui.css | 20817c261c1ff7fc |
| agent-elements | [markdown](https://agent-elements.21st.dev/r/markdown.json) | components/vendor/agent-elements/markdown.tsx | 5774a8ea60ff39ce |
| agent-elements | [markdown](https://agent-elements.21st.dev/r/markdown.json) | components/vendor/agent-elements/utils/cn.ts | d1f1e0d62cb8d8d1 |
| agent-elements | [markdown](https://agent-elements.21st.dev/r/markdown.json) | components/vendor/agent-elements/agent-ui.css | 20817c261c1ff7fc |
| agent-elements | [todo-tool](https://agent-elements.21st.dev/r/todo-tool.json) | components/vendor/agent-elements/tools/todo-tool.tsx | 2a3ae59989d2c276 |
| agent-elements | [todo-tool](https://agent-elements.21st.dev/r/todo-tool.json) | components/vendor/agent-elements/icons.tsx | 5deb63b538acb935 |
| agent-elements | [todo-tool](https://agent-elements.21st.dev/r/todo-tool.json) | components/vendor/agent-elements/utils/format-tool.ts | f65ef6ca21693684 |
| agent-elements | [todo-tool](https://agent-elements.21st.dev/r/todo-tool.json) | components/vendor/agent-elements/utils/cn.ts | d1f1e0d62cb8d8d1 |
| agent-elements | [todo-tool](https://agent-elements.21st.dev/r/todo-tool.json) | components/vendor/agent-elements/agent-ui.css | 20817c261c1ff7fc |
| agent-elements | [tool-group](https://agent-elements.21st.dev/r/tool-group.json) | components/vendor/agent-elements/tools/tool-group.tsx | 73349250873dad69 |
| agent-elements | [tool-group](https://agent-elements.21st.dev/r/tool-group.json) | components/vendor/agent-elements/tools/tool-registry.ts | 33e578edd7f405c6 |
| agent-elements | [tool-group](https://agent-elements.21st.dev/r/tool-group.json) | components/vendor/agent-elements/utils/format-tool.ts | f65ef6ca21693684 |
| agent-elements | [tool-group](https://agent-elements.21st.dev/r/tool-group.json) | components/vendor/agent-elements/utils/cn.ts | d1f1e0d62cb8d8d1 |
| agent-elements | [tool-group](https://agent-elements.21st.dev/r/tool-group.json) | components/vendor/agent-elements/tools/tool-row-base.tsx | f049928325d2a323 |
| agent-elements | [tool-group](https://agent-elements.21st.dev/r/tool-group.json) | components/vendor/agent-elements/types/timeline.ts | 473a2eee0935a709 |
| agent-elements | [tool-group](https://agent-elements.21st.dev/r/tool-group.json) | components/vendor/agent-elements/hooks/use-tool-complete.ts | 8ebcacc22b933095 |
| agent-elements | [tool-group](https://agent-elements.21st.dev/r/tool-group.json) | components/vendor/agent-elements/agent-ui.css | 20817c261c1ff7fc |
| agent-elements | [generic-tool](https://agent-elements.21st.dev/r/generic-tool.json) | components/vendor/agent-elements/tools/generic-tool.tsx | a2202fbc49df12b2 |
| agent-elements | [generic-tool](https://agent-elements.21st.dev/r/generic-tool.json) | components/vendor/agent-elements/types/timeline.ts | 473a2eee0935a709 |
| agent-elements | [generic-tool](https://agent-elements.21st.dev/r/generic-tool.json) | components/vendor/agent-elements/hooks/use-tool-complete.ts | 8ebcacc22b933095 |
| agent-elements | [generic-tool](https://agent-elements.21st.dev/r/generic-tool.json) | components/vendor/agent-elements/tools/tool-row-base.tsx | f049928325d2a323 |
| agent-elements | [generic-tool](https://agent-elements.21st.dev/r/generic-tool.json) | components/vendor/agent-elements/utils/cn.ts | d1f1e0d62cb8d8d1 |
| agent-elements | [generic-tool](https://agent-elements.21st.dev/r/generic-tool.json) | components/vendor/agent-elements/agent-ui.css | 20817c261c1ff7fc |
| agent-elements | [subagent-tool](https://agent-elements.21st.dev/r/subagent-tool.json) | components/vendor/agent-elements/tools/subagent-tool.tsx | 9eca12231030c2e2 |
| agent-elements | [subagent-tool](https://agent-elements.21st.dev/r/subagent-tool.json) | components/vendor/agent-elements/tools/tool-registry.ts | 33e578edd7f405c6 |
| agent-elements | [subagent-tool](https://agent-elements.21st.dev/r/subagent-tool.json) | components/vendor/agent-elements/utils/format-tool.ts | f65ef6ca21693684 |
| agent-elements | [subagent-tool](https://agent-elements.21st.dev/r/subagent-tool.json) | components/vendor/agent-elements/utils/cn.ts | d1f1e0d62cb8d8d1 |
| agent-elements | [subagent-tool](https://agent-elements.21st.dev/r/subagent-tool.json) | components/vendor/agent-elements/tools/tool-row-base.tsx | f049928325d2a323 |
| agent-elements | [subagent-tool](https://agent-elements.21st.dev/r/subagent-tool.json) | components/vendor/agent-elements/types/timeline.ts | 473a2eee0935a709 |
| agent-elements | [subagent-tool](https://agent-elements.21st.dev/r/subagent-tool.json) | components/vendor/agent-elements/hooks/use-tool-complete.ts | 8ebcacc22b933095 |
| agent-elements | [subagent-tool](https://agent-elements.21st.dev/r/subagent-tool.json) | components/vendor/agent-elements/agent-ui.css | 20817c261c1ff7fc |
| agent-elements | [question-tool](https://agent-elements.21st.dev/r/question-tool.json) | components/vendor/agent-elements/question/question-tool.tsx | 409381248d223d51 |
| agent-elements | [question-tool](https://agent-elements.21st.dev/r/question-tool.json) | components/vendor/agent-elements/question/question-prompt.tsx | 0d5a337ff3f06c3f |
| agent-elements | [question-tool](https://agent-elements.21st.dev/r/question-tool.json) | components/vendor/agent-elements/utils/cn.ts | d1f1e0d62cb8d8d1 |
| agent-elements | [question-tool](https://agent-elements.21st.dev/r/question-tool.json) | components/vendor/agent-elements/agent-ui.css | 20817c261c1ff7fc |
| agent-elements | [mcp-tool](https://agent-elements.21st.dev/r/mcp-tool.json) | components/vendor/agent-elements/tools/mcp-tool.tsx | 1ceeacf1c057b65b |
| agent-elements | [mcp-tool](https://agent-elements.21st.dev/r/mcp-tool.json) | components/vendor/agent-elements/utils/format-tool.ts | f65ef6ca21693684 |
| agent-elements | [mcp-tool](https://agent-elements.21st.dev/r/mcp-tool.json) | components/vendor/agent-elements/tools/tool-registry.ts | 33e578edd7f405c6 |
| agent-elements | [mcp-tool](https://agent-elements.21st.dev/r/mcp-tool.json) | components/vendor/agent-elements/tools/tool-row-base.tsx | f049928325d2a323 |
| agent-elements | [mcp-tool](https://agent-elements.21st.dev/r/mcp-tool.json) | components/vendor/agent-elements/utils/cn.ts | d1f1e0d62cb8d8d1 |
| agent-elements | [mcp-tool](https://agent-elements.21st.dev/r/mcp-tool.json) | components/vendor/agent-elements/agent-ui.css | 20817c261c1ff7fc |
| agent-elements | [thinking-tool](https://agent-elements.21st.dev/r/thinking-tool.json) | components/vendor/agent-elements/tools/thinking-tool.tsx | df1cff0df392f458 |
| agent-elements | [thinking-tool](https://agent-elements.21st.dev/r/thinking-tool.json) | components/vendor/agent-elements/types/timeline.ts | 473a2eee0935a709 |
| agent-elements | [thinking-tool](https://agent-elements.21st.dev/r/thinking-tool.json) | components/vendor/agent-elements/hooks/use-tool-complete.ts | 8ebcacc22b933095 |
| agent-elements | [thinking-tool](https://agent-elements.21st.dev/r/thinking-tool.json) | components/vendor/agent-elements/tools/tool-row-base.tsx | f049928325d2a323 |
| agent-elements | [thinking-tool](https://agent-elements.21st.dev/r/thinking-tool.json) | components/vendor/agent-elements/utils/tool-adapters.ts | 1f3a748c20aed59d |
| agent-elements | [thinking-tool](https://agent-elements.21st.dev/r/thinking-tool.json) | components/vendor/agent-elements/utils/cn.ts | d1f1e0d62cb8d8d1 |
| agent-elements | [thinking-tool](https://agent-elements.21st.dev/r/thinking-tool.json) | components/vendor/agent-elements/agent-ui.css | 20817c261c1ff7fc |
| assistant-ui | [elements-background-inbox](https://r.assistant-ui.com/elements-background-inbox.json) | components/vendor/assistant-ui/elements/background-inbox.tsx | 2b55b3ff232531d4 |
| assistant-ui | [elements-surfaces](https://r.assistant-ui.com/elements-surfaces.json) | components/vendor/assistant-ui/elements/surfaces.tsx | 5d81fbb669e67ae2 |
| assistant-ui | [elements-surfaces](https://r.assistant-ui.com/elements-surfaces.json) | components/vendor/assistant-ui/utils/useIsomorphicLayoutEffect.ts | 8db117d730e64065 |
| assistant-ui | [elements-artifact-card](https://r.assistant-ui.com/elements-artifact-card.json) | components/vendor/assistant-ui/elements/artifact-card.tsx | bcd3504b3b13a79d |
| assistant-ui | [elements-checkpoint-history](https://r.assistant-ui.com/elements-checkpoint-history.json) | components/vendor/assistant-ui/elements/checkpoint-history.tsx | e451c6358c8e7e11 |
| assistant-ui | [elements-schedule-card](https://r.assistant-ui.com/elements-schedule-card.json) | components/vendor/assistant-ui/elements/schedule-card.tsx | c2f61a13868feb4d |
| assistant-ui | [elements-connection-state](https://r.assistant-ui.com/elements-connection-state.json) | components/vendor/assistant-ui/elements/connection-state.tsx | 5afe58eaec85737c |
| assistant-ui | [elements-range](https://r.assistant-ui.com/elements-range.json) | components/vendor/assistant-ui/utils/range.ts | 3506d5f07865c042 |
| assistant-ui | [elements-memory-chips](https://r.assistant-ui.com/elements-memory-chips.json) | components/vendor/assistant-ui/elements/memory-chips.tsx | 43b9d2ff8c27c00d |
| assistant-ui | [elements-elicitation-form](https://r.assistant-ui.com/elements-elicitation-form.json) | components/vendor/assistant-ui/elements/elicitation-form.tsx | 9d98ed74254ada76 |
| assistant-ui | [elements-receipt-focus](https://r.assistant-ui.com/elements-receipt-focus.json) | components/vendor/assistant-ui/elements/receipt-focus.ts | 0be780a30c042bbb |
| assistant-ui | [elements-receipt-focus](https://r.assistant-ui.com/elements-receipt-focus.json) | components/vendor/assistant-ui/utils/useIsomorphicLayoutEffect.ts | 8db117d730e64065 |
| assistant-ui | [elements-cost-meter](https://r.assistant-ui.com/elements-cost-meter.json) | components/vendor/assistant-ui/elements/cost-meter.tsx | 8acf75f340e82304 |
| assistant-ui | [elements-tokens](https://r.assistant-ui.com/elements-tokens.json) | components/vendor/assistant-ui/utils/tokens.ts | 009b617a40b7bdc6 |
| ai-elements | [chain-of-thought](https://ai-sdk.dev/elements/api/registry/chain-of-thought.json) | components/vendor/ai-elements/chain-of-thought.tsx | 5ccfddc925c98161 |
| ai-elements | [sources](https://ai-sdk.dev/elements/api/registry/sources.json) | components/vendor/ai-elements/sources.tsx | 6fa3ca4cc72a87e3 |
| ai-elements | [task](https://ai-sdk.dev/elements/api/registry/task.json) | components/vendor/ai-elements/task.tsx | ecc83dc185a0b0fe |
