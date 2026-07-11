---
name: epicstaff-state
description: Use when a flow must persist data across sessions or per user — conversation memory, counters, user profiles, saved files. Covers the sandbox storage path-lock, attaching a persistent folder via GraphStorageFile, the EpicStaffStorage read/write API, and the load-on-init / save-on-exit pattern.
---

# EpicStaff State — Persisting Data Across Sessions

A flow session is stateless by default: variables reset every run. To remember anything between runs (a user's history, a running total, a profile), a Python node must read and write **persistent storage**. This skill covers how to unlock that storage and the pattern for per-user state.

---

## Core principle — storage is path-locked

A Python node with `use_storage: true` gets an `EpicStaffStorage` handle, but the sandbox **hard-locks its allowed paths to `sessions/<session_id>/`** — a folder that is unique per run and thrown away after. Writing there does NOT persist across sessions.

To persist, you must **attach a durable folder to the graph** (a `GraphStorageFile`). Once attached, the converter adds that path to the node's `storage_allowed_paths`, and reads/writes under it survive across every session.

> Native `GraphOrganization.persistent_variables` is NOT a substitute for per-user state: the Telegram trigger never resolves a per-user record, so it is effectively broken on the bot path. Use storage instead.

---

## One-shot via create_flow_from_spec

A `FlowSpec` builds a storage-backed flow in one call: set `use_storage: true` on
each python node that touches storage, and list the durable folder(s) in
top-level `storage_paths` (e.g. `["chat_memory/"]`). The build creates the
folder(s) if missing and attaches them as `GraphStorageFile`s, so persistence
works on the first run — no separate create/attach step. The manual sequence
below is still the way when adding storage to a flow that already exists.

## Setup — attach a folder (once)

```
create_storage_folder("chat_memory/")            # make the folder
attach_storage_to_flow(flow_id, ["chat_memory/"]) # attach it to the graph (GraphStorageFile)
```

- A folder path **ending in `/` is treated as a prefix** — every file under it becomes readable/writable.
- Verify it worked: after attaching, the node's `storage_allowed_paths` should list your folder alongside `sessions/<id>/`. Confirm with `list_flow_storage(flow_id)` or by inspecting a run.
- Set `use_storage: true` on every Python node that touches storage (via `add_node` config or `update_node`).

---

## The EpicStaffStorage API

```python
from epicstaff_storage.storage import EpicStaffStorage
s = EpicStaffStorage()
s.exists(path) -> bool
s.read(path)   -> str
s.write(path, data: str)
s.delete(path)
s.list(prefix) -> list
```

Always guard storage calls and **degrade gracefully** — if the folder isn't attached yet, capture the error into the returned data rather than crashing the node:

```python
try:
    from epicstaff_storage.storage import EpicStaffStorage
    s = EpicStaffStorage()
    if s.exists(path):
        loaded = json.loads(s.read(path))
except Exception as e:
    mem["load_error"] = str(e)
```

---

## Pattern — per-user memory (load-on-init / save-on-exit)

Key each user's state by a **stable id** (for Telegram, `tg-<from.id>`; normalize it in the same init node that parses the channel payload — see the `epicstaff-channels` skill). One JSON file per user under the attached folder:

```
chat_memory/tg-102179151.json
{"user_key":"tg-102179151","display_name":"…","first_seen":"…","turns":[{"q":"…","a":"…","ts":"…"}]}
```

- **Load-on-init node** (early, `use_storage`): read `chat_memory/<user_key>.json` into `variables.memory`; default to an empty record if absent.
- **Save-on-exit node** (`use_storage`, on the normal answer path): append `{q, a, ts}` to `turns`, **cap the list** (e.g. last 40) so the file can't grow unbounded, write it back.
- Feed the accumulated history into a crew/agent node's `input_map` (`"history": "variables.memory.turns"`) so the model keeps multi-turn context.

### Worked example — chat-bot commands over stored memory

- `/context` — estimate stored tokens (`sum(len(q)+len(a)) // 4`) against a fixed budget and render a progress bar:
  `bar = "▓"*filled + "░"*(10-filled)` → `░░░░░░░░░░ 0% · 0/8000 tokens · 0 turns`.
- `/clrctx` — overwrite the file with an empty `turns` list (keep `first_seen`).
- `/whoami`, `/history` — read straight from the loaded record; no crew needed.

Route commands away from the crew with a CDT (`variables.session.is_command == True` → Command Handler) — see the CDT rules in the `epicstaff` reference skill.

---

## Storage management tools

| Tool | Purpose |
|---|---|
| `list_storage(path)` / `storage_tree(path)` | Browse a folder / recursive tree |
| `get_storage_info` | Bucket/usage info |
| `create_storage_folder(path)` | Make a folder |
| `upload_storage_file(folder, name, base64)` | Upload a file |
| `delete_storage_paths([...])` | Delete files/folders |
| `rename_storage` / `move_storage` / `copy_storage` | Reorganize |
| `attach_storage_to_flow(flow_id, paths)` | Attach a path to a graph (unlocks it for nodes) |
| `detach_storage_from_flow` / `list_flow_storage(flow_id)` | Detach / list a graph's attached paths |

---

## Gotchas

- **`use_storage` alone is not enough.** Without an attached folder, writes are confined to the ephemeral `sessions/<id>/` and vanish. Attach the folder.
- **Folder paths need the trailing `/`** to act as a writable prefix.
- **Cap growing lists** (history/turns) inside the save node — nothing else bounds file size.
- **Guard every storage call**; return a `*_error` field instead of raising, so a missing attachment degrades to "no memory" rather than a dead node.
- **`persistent_variables` is broken on the Telegram path** — don't rely on it for per-user state.

Related: `epicstaff-channels` (normalizing the per-user key from a Telegram/webhook payload), `epicstaff` (CDT command routing, tool signatures).
