# Voice input

The microphone in the composer dictates into the message box, like the ChatGPT and Codex apps.

## What was tried (2026-10-23)

| Route | Result |
| --- | --- |
| `https://chatgpt.com/backend-api/transcribe` with the ChatGPT sign-in | 403, Cloudflare challenge (browser only) |
| `POST https://api.openai.com/v1/audio/transcriptions` with the ChatGPT sign-in | 401 `rejected_by_access_enforcement`: the subscription token is not allowed on that route |
| `wss://api.openai.com/v1/realtime` (transcription and realtime sessions) with the ChatGPT sign-in | Connects and accepts audio, then fails with `missing_compute_residency_info` (Codex sends residency details Mars cannot reproduce) |
| `wss://api.anthropic.com/api/ws/speech_to_text/voice_stream` with the Claude sign-in | Works: live interim text while speaking, a final punctuated transcript, about 0.3 s behind the voice |

Mars uses the last one. It is the stream Claude Code's own voice mode uses. Anthropic's terms
say Claude sign-in tokens are for Claude Code and claude.ai; Mars already uses the owner's Claude
sign-in for chat on the owner's instruction, and voice follows the same choice.

## How it works

1. The browser records the microphone (`getUserMedia`, an AudioWorklet), converts it to 16 kHz
   mono 16-bit PCM (`apps/ui/lib/pi/pcm.ts`) and sends it every 200 ms as base64 JSON, because
   every Mars proxy accepts JSON.
2. The host (`packages/pi-host/voice.mjs`) holds one upstream WebSocket per recording with the
   Claude token from Pi's credentials (refreshed by Pi), sends keep-alives, forwards audio, and
   ends with `CloseStream`. The token never reaches the browser.
3. The browser long-polls the transcript; interim text replaces itself, finished segments are
   kept. Stop waits for the last words (at most 5 s).

Routes (owner auth): `POST /api/voice` `{ language }` starts; `POST /api/voice/:id/audio`
`{ audio }` (base64, at most 64 KB decoded, whole samples); `GET /api/voice/:id?since&wait`
polls (up to 15 s); `POST /api/voice/:id/stop` and `/cancel`. At most two recordings at once;
a recording idle for a minute or longer than five minutes is stopped.

In the composer: the microphone button is off until Claude is connected; click to dictate,
words appear after what was already typed, click again to keep them, Escape to cancel. It needs
HTTPS (or localhost) for microphone access.
