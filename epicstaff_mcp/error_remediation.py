"""Maps known EpicStaff backend error signatures to actionable remediation text.

Pure string matching over an already-received HTTP error body — no I/O, no
mutation. Each rule here is verified against the EpicStaff backend source (see
`docs/mcp-usage-issues.md` and `skills/flow-debugger/SKILL.md`'s Error
Fingerprints table), not guessed from the message alone. Deliberately narrow:
only wraps signatures that map confidently to one root cause. An unmatched
error is returned unchanged by the caller — never invent a remediation for a
pattern that could mean several different things.
"""

from __future__ import annotations

from collections.abc import Callable

_Matcher = Callable[[int, str], bool]


def _no_start_node(status_code: int, detail: str) -> bool:
    # tables/exceptions.py: GraphEntryPointException, status_code=400,
    # default_detail="No node connected to start node" — raised synchronously
    # when a session is started against a flow whose __start__ has no outgoing edge.
    return status_code == 400 and "No node connected to start node" in detail


def _rag_required_on_agent_update(status_code: int, detail: str) -> bool:
    # crew_serializers.py AgentWriteSerializer.update(): raises
    # serializers.ValidationError({"rag": "This field is required when
    # changing to a new knowledge_collection"}) — only on UPDATE, not create.
    return (
        status_code == 400
        and "required when changing to a new knowledge_collection" in detail
    )


def _unhandled_backend_typeerror(status_code: int, detail: str) -> bool:
    # utils/exception_handler.py custom_exception_handler: any exception that
    # is not a DRF APIException (e.g. a plain TypeError from splatting an
    # unexpected kwarg into a model constructor) is masked to
    # "{ClassName}: Unpredictable error" with status 500 in production. The
    # most common concrete cause the MCP has hit is a stray CDT/DT
    # condition_group field (see mcp-usage-issues.md items B and F), but this
    # signature is generic — any unhandled backend TypeError looks identical.
    return status_code == 500 and "TypeError" in detail


_RULES: tuple[tuple[_Matcher, str], ...] = (
    (
        _no_start_node,
        "The flow's __start__ node has no outgoing edge. Wire one with "
        'add_edge(flow_id, "__start__", "<first-node>"), then '
        "init_flow_metadata(flow_id) if you added the edge by hand "
        "(sync_metadata=True on add_edge already does this for you).",
    ),
    (
        _rag_required_on_agent_update,
        "update_agent set knowledge_collection on an agent that didn't "
        "already have that collection assigned, without a rag object. Pass "
        "rag_type ('naive'|'graph') and rag_id together with "
        "knowledge_collection in the same update_agent call.",
    ),
    (
        _unhandled_backend_typeerror,
        "The backend raised an unhandled TypeError (masked to a generic 500 "
        "with no detail in production). The most common confirmed cause is a "
        "stray field in a CDT/DT condition_group — e.g. a 'next_node' name, "
        "'conditions', or 'group_type' key that doesn't belong on this node "
        "type. Re-check the payload via patch_cdt_node/patch_dt_node, which "
        "reject those fields before they reach the backend. If you weren't "
        "touching CDT/DT routing, this is likely an unrelated backend bug — "
        "see docs/mcp-usage-issues.md.",
    ),
)


def find_remediation(status_code: int, detail: str) -> str | None:
    """Return remediation text for a recognized error signature, else None."""
    for matches, remediation in _RULES:
        if matches(status_code, detail):
            return remediation
    return None
