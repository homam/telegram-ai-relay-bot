# Roadmap

Features that have been considered or designed but aren't built yet. Ordered
within each tier by expected day-to-day impact for a personal-chat bot.

## Considered + designed, not built

These had a design conversation; the trade-offs are recorded here so we don't
re-litigate them next time.

- **Organic in-chat AI image generation.** Have the model produce text + an
  inline diagram/illustration in the same response. Real cost: OpenAI requires
  switching from Chat Completions to Responses API + the `image_generation`
  tool; Gemini needs `responseModalities: ['TEXT', 'IMAGE']`; Anthropic
  doesn't generate images at all. The grammY stream pipeline currently handles
  `AsyncIterable<string>` — adding image parts means re-architecting the
  relay to handle interleaved text + image parts, plus storing image refs in
  S3/DDB for follow-up turns. Telegram UX is also fragmented (text bubble →
  photo bubble → text bubble) since `sendMessageDraft` is text-only. **Status:
  punted in favour of `/imagine`** (below) until use cases emerge.

- **`/imagine <prompt>` explicit image generation.** The simpler alternative.
  Decoupled from chat context — `/imagine sunset over mountains` calls
  `images.generate` (model `gpt-image-1`, ~$0.04–$0.17/image), bot replies
  with a photo via `sendPhoto` (uploaded via the same native `fetch +
  FormData` pattern as `/say`). Falls back to OpenAI if the active provider
  is Anthropic. **Status: ready to implement when desired** — small footprint
  (~1 hour of work).

## Quality-of-life additions

- **Custom system prompts per session** (`/system <text>` or attach when
  creating a `/new`). Persisted in the session row, prepended to every
  request. Tiny implementation, high utility for "you are a translator" /
  "you are a code reviewer" workflows.

- **`/regenerate`.** Drop the last assistant turn, re-run with the same
  prompt; optional `--model <id>` arg picks a different variant for the
  retry. Common need; cheap to implement.

- **`/search <text>`.** Find prior sessions whose messages mention `<text>`.
  v1 = naive client-side filter on `Query` results; will need a GSI or
  full-text index once history is large. Sessions accumulate fast in active
  use; chronological-only listing already feels limited.

- **`/export`.** Send the active session as a Markdown file via
  `sendDocument` (same native-FormData upload pattern as `/say`). Useful
  when a conversation produces something worth keeping outside Telegram.

- **Auto-summarization for long sessions.** When the next request would
  push input tokens past a threshold (~40K for `gpt-5.4-mini` to leave
  output room), summarize older turns into a single system message and
  keep recent turns verbatim. Avoids context-limit errors on long chats.

- **TTS voice mode toggle (`/voice on|off|auto`).** Currently `/say` is
  on-demand only. Adding `auto` would auto-send a voice version when the
  user's input was a voice note (talk to me → I talk back). `on` always,
  `off` never. Per-user setting in `UserState`.

## Power features

- **Document / PDF analysis.** User uploads a PDF or .txt; Lambda extracts
  text (e.g. `pdf-parse`) and relays to the active model as context. Feels
  natural in Telegram. Bigger files would need S3 storage and pagination.

- **Tool use / web fetch.** All three providers support function calling.
  A `web_fetch` tool turns the bot into a research assistant. Larger
  surface area; do this only after one or two of the items above land,
  since tool-use changes the streaming shape.

- **Comparison mode** (`/compare <prompt>`). Send the same prompt to all
  three providers, get three streamed replies side-by-side. Interesting for
  evaluating, but uses 3× the budget per turn.

## Cost / observability

- **Per-month USD breakdown** in `/usage` — currently only "today".
- **Per-provider sub-caps.** Separate cap per provider so experimenting with
  `gpt-5.4-pro` or `claude-opus-4-7` doesn't burn the day's budget on one
  model.
- **80% cap warning.** Proactive Telegram message when daily spend crosses
  80% of the cap, instead of the bot just going silent at 100%.

## Known limitations not yet roadmapped

These are documented but not actively planned — the trade-off is acceptable
for current usage. Listed here so we don't pretend they don't exist.

- **Multi-message responses (>4096 chars) stay plain text.** The post-stream
  MarkdownV2 reformat only handles single-message responses; re-splitting a
  converted MarkdownV2 string back across message boundaries while keeping
  delimiters balanced is non-trivial.
- **Telegram albums coalesce into multiple replies, not one.** Sending three
  photos in one Telegram message produces three separate updates, each
  replied to independently.
- **`/say` truncates at 4096 chars** (OpenAI TTS hard limit). Long replies
  get an "(audio truncated)" caption. Chunked TTS is doable but adds
  scheduling complexity.
- **Voice transcription requires OpenAI configured.** Whisper is OpenAI-
  only; Anthropic doesn't transcribe and Gemini's audio path needs a
  multimodal call shape we haven't wired up.
- **Stickers / GIFs / animations** get a polite refusal, not relayed.
