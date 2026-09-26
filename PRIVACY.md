# Privacy and disclosures

The plugin is a thin Enot client. Cloud speech processing runs on your configured API host (default `https://enot.upl.one`). Whisper, prompts, diarization, OpenRouter keys, and billing secrets are **not** in this plugin.

## Network

All calls use Obsidian `requestUrl` to your API base URL:

| Path | Purpose |
|------|---------|
| `POST /v1/register` | Issue a personal API key |
| `GET /v1/me` | Trial / plan / hours / checkout links |
| `POST /v1/me/settings` | Sync language and similar prefs |
| `GET /v1/me/shortcut` | Download personal Apple Shortcut |
| `POST /v1/process-audio` | Upload audio or video for processing |
| `GET /v1/jobs`, `GET /v1/inbox`, `POST …/ack` | Poll and pull finished notes |
| calibration / name-hints / brand-hints / clarify-queue | Glossaries and ASR clarify UI |

Checkout opens `checkout_url` / `checkout_urls` from `/v1/me` (Whop). No other third-party hosts are hard-coded.

## Audio and video

Media reaches the API in three ways:

1. **In-plugin microphone** — record in Obsidian, then upload to `/v1/process-audio`.
2. **In-plugin file picker** — choose a local audio/video file, upload to the same endpoint.
3. **Apple Shortcut** (optional) — downloads from settings; the Shortcut posts audio with your key baked in.

Audio bytes are sent only to your API URL. They are not written into the vault as media files; the plugin writes Markdown notes after the server finishes.

## Vault

Does not create empty `System/`. Creates parent folders only when writing:

- Notes under `01 Meetings/`, `00 Inbox/`, `04 Resources/til/`, `05 Decisions/`
- Temporary drafts under `01 Meetings/`
- Stubs in `09 People/`, `10 Topics/`, `02 Projects/`

The personal API key and settings live in plugin `data.json` inside the vault (not in the GitHub release).

## Clipboard

Optional Copy button for the API key.

## Pricing

A 7-day trial starts at Register. After that, paid plans are sold via Whop. The plugin itself is free to install; cloud processing is the paid service.
