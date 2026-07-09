---
name: epicstaff-channels
description: Use when a flow must receive from or reply to an external channel — Telegram bots (messages, inline buttons, callback queries), incoming webhooks, or uploaded file/voice inputs. Covers trigger wiring, the reply-node pattern (there is NO built-in reply node), and the differing payload shapes.
---

# EpicStaff Channels — Triggers In, Replies Out

Trigger nodes bring an external event *into* a flow. **There is no built-in node that sends a reply back out** — you build a Python node that calls the channel's API (`sendMessage`, an HTTP callback, etc.). This skill is the playbook for both directions.

Prerequisite: the general flow-building rules in the `epicstaff` reference skill (dual-wiring, `init_flow_metadata`, `def main`, single-out ports).

---

## Core principle — the two halves

| Direction | How | Where the data lives |
|---|---|---|
| **In** | A trigger node (`telegramtriggernode`, `webhooktriggernode`) fires the flow | The raw event lands in `variables` (Telegram: `variables.telegram_payload`; webhook: the handler's `trigger_payload`) |
| **Out** | A **Python node you author** POSTs to the channel API | Reads the answer + destination from `variables` |

Both halves must agree on a **stable destination key** (Telegram `chat_id`, a webhook callback URL). Normalize it once in an early node so every reply path can read it — don't re-derive it from the raw payload at the reply node.

---

## Telegram

### 1. Trigger setup

- Node type `telegramtriggernode`; config `telegram_bot_api_key` + `fields[]`.
- Each field maps a payload path → a variables path: `{ "parent": "message", "field_name": "text", "variable_path": "variables.intake.question" }`.
- **Dual-wire** like any trigger: connect BOTH `__start__` → first node AND `Telegram Intake` → first node, so manual runs and real messages share the path.
- Register the webhook with `register_telegram_trigger(flow_id, telegram_trigger_node_id=<id>)` — needs an ngrok tunnel configured (`get_ngrok_config` / `update_ngrok_config`).

### 2. The whole update arrives as `variables.telegram_payload`

The backend trigger fires on **every** Telegram update type and passes the **entire** update object through — it does not branch on message vs. button tap. So the field mappings only populate cleanly for a text `message`; for anything else, read `telegram_payload` directly in a Python node.

### 3. Two payload shapes — a text message vs. a button tap

A **button tap is a `callback_query`, NOT a `message`.** The fields live in different places:

| Need | Text message | Button tap (callback_query) |
|---|---|---|
| user | `telegram_payload.message.from` | `telegram_payload.callback_query.from` |
| chat id | `telegram_payload.message.chat.id` | `telegram_payload.callback_query.message.chat.id` |
| text/command | `telegram_payload.message.text` | `telegram_payload.callback_query.data` |
| ack id | — | `telegram_payload.callback_query.id` |

**Normalize both in one init node** so downstream nodes never care which arrived:

```python
def main(tg=None):
    tg = tg if isinstance(tg, dict) else {}
    cbq = tg.get("callback_query") or {}
    if cbq:                                    # button tap
        frm = cbq.get("from") or {}
        chat = (cbq.get("message") or {}).get("chat") or {}
        text = cbq.get("data") or ""
        callback_query_id = cbq.get("id")
    else:                                      # text message
        msg = tg.get("message") or {}
        frm = msg.get("from") or {}
        chat = msg.get("chat") or {}
        text = msg.get("text") or ""
        callback_query_id = None
    return {"session": {
        "chat_id": chat.get("id"),
        "user_key": f"tg-{frm.get('id')}" if frm.get("id") is not None else "anonymous",
        "callback_query_id": callback_query_id,
        "text": (text or "").strip(),
    }}
```

### 4. Reply node (Python) — the only way to answer

```python
import json, urllib.request

BOT_TOKEN = "<BOT_TOKEN>"   # keep the real token out of the skill; source from config/env

def _api(method, payload):
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/{method}"
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.status == 200

def main(answer=None, chat_id=None, callback_query_id=None):
    # A button tap must be acknowledged or its spinner never stops.
    if callback_query_id:
        _api("answerCallbackQuery", {"callback_query_id": callback_query_id})
    if not chat_id:                       # non-Telegram run — nothing to reply to
        return {"telegram_sent": False, "reason": "no chat_id"}
    return {"telegram_sent": _api("sendMessage", {"chat_id": chat_id, "text": answer or "…"})}
```

Feed the reply node `chat_id` from the **normalized** `variables.session.chat_id` — NOT `telegram_payload.message.chat.id`, which is null on button taps.

### 5. Inline buttons

Attach `reply_markup.inline_keyboard` to the `sendMessage` payload. Each button's `callback_data` should be the command string you route on:

```python
KEYBOARD = {"inline_keyboard": [
    [{"text": "📊 Context", "callback_data": "/context"}, {"text": "🕒 History", "callback_data": "/history"}],
    [{"text": "❓ Help", "callback_data": "/help"}],
]}
# ... _api("sendMessage", {"chat_id": chat_id, "text": answer, "reply_markup": KEYBOARD})
```

A tap re-fires the whole flow with `callback_query.data == "/context"` → your init node treats it exactly like the typed command. Always `answerCallbackQuery` (step 4) so the button stops spinning.

---

## Webhooks

- Node type `webhooktriggernode`; config `webhook_trigger.path` (NOT `webhook_path`) + a `python_code` handler.
- The handler receives the request body as `trigger_payload` and returns a dict that merges into `variables`. Its `output_variable_path` is forced to `"variables"` by the runtime — do not override it.
- Register with `register_webhooks()`. Dual-wire `__start__` + the trigger node into the first real node.

```python
def main(trigger_payload=None):
    payload = trigger_payload or {}
    return {"intake": {"question": payload.get("question") or payload.get("text") or "",
                       "user_id": payload.get("user_id") or "webhook-user", "channel": "webhook"}}
```

---

## File & voice inputs

`fileextractornode` (documents) and `audiotranscriptionnode` (audio) read uploaded `GraphFile`s and output extracted text.

**Their `input_map` values MUST start with `variables.files.`** — the `FileNodeValidator` rejects anything else:

```
Doc Extractor    input_map = {"document": "variables.files.document"}
Voice Intake     input_map = {"audio": "variables.files.audio"}
```

Point their `output_variable_path` at an enrichment namespace (e.g. `variables.enrichment`) and read the transcript/text downstream.

---

## Gotchas

- **No reply node exists.** If a bot must talk back, you build a Python `sendMessage` node — do not look for a built-in one.
- **Button taps ≠ messages.** They arrive as `callback_query` with a different shape; a reply node that only reads `telegram_payload.message.*` sees nulls. Normalize both shapes in one init node.
- **Un-acknowledged taps spin forever.** Always `answerCallbackQuery(callback_query.id)`.
- **`chat_id` must come from a normalized var**, not the raw message path, or taps silently fail to get a reply.
- **File/voice `input_map` must be under `variables.files.*`** or the node is rejected at build.
- **Triggers need dual-wiring** (`__start__` + trigger → first node) or manual runs fail with "No node connected to start node".

Related: `epicstaff-state` (per-user memory for a chat bot), `epicstaff` (tool signatures + port rules), `epicstaff-flow` (full build pipeline).
