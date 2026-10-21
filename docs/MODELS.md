# Models

Settings, Models, saved on the host in `<MARS_PI_ROOT>/data/model-settings.json`.
`GET /api/settings/models` and `POST /api/settings/models` (owner auth) read and change
`{ defaultModel, defaultEffort, backgroundModel }`; each is `""` when unset. /api/state carries
them as `modelSettings`.

## Default model and effort

With a default model set, New chat starts on it (the UI sends no model; the host applies the
default and clamps the default effort to the model's levels). Without one, a new chat copies the
current chat's model and effort. Side chats keep their own rules. Any chat can still switch.

## Background model

An optional cheap model (for example an OpenCode Go model, listed once its key is saved in
Apps). After a final answer in a chat that is not a helper's, it:

- replaces an automatic title (made from the first message) once with a 3 to 6 word title. A
  title the owner set is never replaced (`auto` is false on the title document).
- writes a one-line, past-tense summary for up to three activity groups of three or more tool
  calls that have none, stored in the native `mars.activity-summaries` document keyed like the
  UI's activity group ids (`<entryId>:<index>`, see `activityGroups` in
  `packages/pi-host/model-settings.mjs`). /api/state returns them as `summaries`; the UI shows
  the summary as the group title and moves the counts beside it.

What it sees: for titles, the first message and first reply (600 characters each); for
summaries, only tool names and the first 120 characters of each call's main argument, never tool
output. Requests are one short, tool-free call (at most 120 output tokens). A failure leaves the
plain wording; nothing waits on it.

## Output cap

`models.maxOutputTokens` (default 32,000) caps every request, never above the model's own
`maxTokens`. Thinking counts towards it.
