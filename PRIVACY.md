# Privacy and disclosures (plugin)

The Obsidian plugin is a thin Enot client. Cloud speech processing runs on your configured API host (default `enot.upl.one`).

**Service legal documents (controller, retention, subprocessors):**

- [Privacy Policy](https://enot.upl.one/legal/privacy)
- [Terms of Service](https://enot.upl.one/legal/terms)

Whisper, prompts, diarization, OpenRouter keys, and billing secrets are **not** shipped inside this plugin binary.

## Network

All calls use Obsidian `requestUrl` to your API base URL:

| Path | Purpose |
|------|---------|
| `POST /v1/register` | Issue a personal API key (requires accepting Terms/Privacy) |
| `GET /v1/me` | Trial / plan / hours / checkout links |
| `DELETE /v1/me` | Delete cloud account and server-side data |
| `POST /v1/me/settings` | Sync language and similar prefs |
| `GET /v1/me/shortcut` | Download personal Apple Shortcut |
| `POST /v1/process-audio` | Upload audio or video for processing |
| `GET /v1/jobs`, `GET /v1/inbox`, `POST …/ack` | Poll and pull finished notes |
| calibration / name-hints / brand-hints / clarify-queue | Glossaries and ASR clarify UI |
| `GET /legal/privacy`, `GET /legal/terms` | Public legal documents |

Checkout opens `checkout_url` / `checkout_urls` from `/v1/me` (Whop).

## Audio and notes

Media is sent to your API URL for processing. Audio is not stored long-term as a media library; note text may exist on the server until the plugin acknowledges delivery, then job bodies are purged. Finished Markdown is written into your vault by the plugin.

## Vault

Creates parent folders only when writing notes. Optional Danger-zone wipe removes Enot-marked notes under PARA folders (see in-app confirmation list). The personal API key lives in plugin `data.json` inside the vault (not in the GitHub release).

## Pricing

A 7-day trial starts at Register. After that, paid plans are sold via Whop. The plugin itself is free to install; cloud processing is the paid service.
