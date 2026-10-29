---
name: es-voice
description: Give an EpicStaff agent a voice and a phone number — voice configs (OpenAI Realtime, ElevenLabs, Gemini Live), an agent's voice settings, Twilio voice channels — and read its voice conversation history (chats, call recordings, logged events). Use when the user wants to talk to an agent by voice, put an agent on a phone line, or review voice calls. Not for flows.
---

# Voice agents

One responsibility: set up and inspect **voice** for an agent. Voice is not part of a flow — a
voice conversation runs an AgentDefinition (its instructions, LLM, surfaces and knowledge) through a
realtime provider, in the EpicStaff **Chats** page or over a phone call. Nothing here goes in flow
source.

Connect first (`es-connect`). The agent must exist (`es-catalog` → `create_agent`).

## The chain — build it in this order

```
voice config  ──►  agent voice settings  ──►  voice channel (Twilio number)  ──►  calls / chats
create_voice_config   set_agent_voice            create_voice_channel               list_voice_chats
```

| Stage | Create / change | Read | Remove |
|---|---|---|---|
| Voice config | `create_voice_config`, `update_voice_config` | `list_voice_configs` | `delete_voice_config` |
| Model registry | `create_voice_model` | `list_voice_configs include_models` | `delete_voice_model` |
| Agent voice | `set_agent_voice` | `list_voice_agents` | `delete_agent_voice` |
| Voice channel | `create_voice_channel`, `update_voice_channel` | `list_voice_channels`, `list_twilio_phone_numbers` | `delete_voice_channel` |
| History | — | `list_voice_chats`, `get_voice_chat` | `delete_voice_chat` |

1. **Voice config** — `list_voice_configs` first (reuse). `run_quickstart` for openai / gemini already
   made one with the bundle's name. Otherwise `create_voice_config(provider, name, api_key_env)`:
   - `provider`: `openai` (OpenAI Realtime), `elevenlabs`, or `gemini` (Gemini Live).
   - The provider key comes from an environment variable of the MCP server (`api_key_env`, stored as
     the org secret `es-mcp:<ENV>`) or an existing secret (`api_key_secret`) — never inline. A config
     without a key cannot start a session; add one later with `update_voice_config(api_key_env)`.
   - `model_name` defaults per provider. An OpenAI model must be in the realtime model registry
     (`list_voice_configs include_models`); `create_voice_model` registers another one.
   - Provider-only fields: openai `base_url`, `transcription_model_name`, `transcription_api_key_*`;
     openai / gemini `voice_recognition_prompt`; elevenlabs `language`. A field the provider lacks is
     refused.
   - Config names are **not** unique — refer to configs by id once you have one.
   - `update_voice_config(provider, config, …)` changes a config in place (PATCH: only what you pass;
     `null` clears an optional field) — every agent using it picks the change up next session.
2. **Agent voice** — `set_agent_voice(agent, provider, config, voice)`. Creates the settings on first
   use, then PATCHes only what you pass. OpenAI / Gemini voices come from a fixed list
   (`list_voice_configs include_voices`); an ElevenLabs voice is a free-form voice id. Also:
   `wake_word` (default: the agent's name), `stop_prompt` (default "stop"), `language` (ISO-639-1),
   `voice_recognition_prompt` (transcription hint). `provider: null` switches voice off but keeps the
   settings and history. `list_voice_agents` shows who has voice.
3. **Try it** — the user talks to the agent in the EpicStaff Chats page (a live audio session is not
   something an MCP tool can hold).
4. **Phone line (optional)** — `list_voice_channels` first (reuse; it shows each channel's agent,
   number and webhook trigger). Otherwise `create_voice_channel(name, agent, account_sid,
   auth_token_env, phone_number, webhook_trigger)`:
   - The Twilio auth token: `auth_token_env` / `auth_token_secret`, like any credential.
   - `webhook_trigger`: id of an existing **public (ngrok)** webhook trigger — localhost is refused,
     Twilio must reach it. Without one the channel cannot take calls.
   - It saves the channel, then the Twilio settings, then points the number's voice webhook at the
     channel. A partial failure says what was saved and how to fix it (`update_voice_channel`).
   - `list_twilio_phone_numbers` lists the account's numbers and which channel each routes to.
   - `update_voice_channel(configure_webhook: true)` re-points the number (e.g. after a tunnel change).

## Reading history

- `list_voice_chats(agent?)` — sessions and calls: start/end, end reason, provider config, voice.
- `get_voice_chat(chat, include_events?)` — one chat with its recordings (inbound = caller, outbound =
  agent; file URL) and, on request, the provider events logged for it (transcripts, tool calls; long
  strings cut). Events are found by scanning the org's event log — use `include_events` only when
  needed.
- `delete_voice_chat` deletes a chat and its recordings for good.

## Deletes

| Tool | Effect |
|---|---|
| `delete_voice_config` | For good; agents using it have their voice switched off (`dry_run: true` lists them first). Skipped only when an agent you cannot see uses it. |
| `delete_agent_voice` | For good; the agent's chats stop being listed and channels routed to it lose their destination. Prefer `set_agent_voice(provider: null)`. |
| `delete_voice_channel` | Recycle bin (`restore_from_recycle_bin kind "realtime_channel"`); the Twilio number still points at it. |
| `delete_voice_model` | For good; custom registry models only. |

## Legacy default slots

`get_settings` shows `voice_llm_config` / `transcription_llm_config`; `update_default_models` sets
them to a **legacy** realtime / transcription config (`list_voice_configs include_legacy`). These are
deprecated upstream: voice agents use their own voice config, not these defaults.

## Never

- Put a provider key or Twilio auth token in a tool argument — only env var names or secret refs.
- Echo a channel's routing token or a chat's connection key — the tools never return them.
