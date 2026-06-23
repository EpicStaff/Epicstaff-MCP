"""MCP tools for managing EpicStaff flows (visual workflows) including nodes and edges."""
from __future__ import annotations

import asyncio
from typing import Any

from epicstaff_mcp.client import get_client
from epicstaff_mcp.exceptions import EpicStaffAPIError
from epicstaff_mcp.tools import _flow_validation as fv

# Maps node_type string to the API endpoint prefix
NODE_TYPE_TO_ENDPOINT: dict[str, str] = {
    "crewnode": "crewnodes",
    "pythonnode": "pythonnodes",
    "startnode": "startnodes",
    "endnode": "endnodes",
    "subgraphnode": "subgraph-nodes",
    "codeagentnode": "code-agent-nodes",
    "fileextractornode": "file-extractor-nodes",
    "audiotranscriptionnode": "audio-transcription-nodes",
    "decisiontablenode": "decision-table-node",
    "telegramtriggernode": "telegram-trigger-nodes",
    "webhooktriggernode": "webhook-trigger-nodes",
}


async def list_flows(
    limit: int = 100, offset: int = 0, search: str | None = None
) -> dict[str, Any]:
    """List all flows (lightweight — no node detail). Supports pagination and search."""
    params: dict[str, Any] = {"limit": limit, "offset": offset}
    if search:
        params["search"] = search
    async with get_client() as client:
        return await client.get("/api/graph-light/", params=params)


async def get_flow(flow_id: int) -> dict[str, Any]:
    """Get full flow details including all nodes and edges."""
    async with get_client() as client:
        return await client.get(f"/api/graphs/{flow_id}/")


async def create_flow(
    name: str,
    description: str | None = None,
    epicchat_enabled: bool = False,
) -> dict[str, Any]:
    """Create a new empty flow."""
    payload: dict[str, Any] = {"name": name, "epicchat_enabled": epicchat_enabled}
    if description is not None:
        payload["description"] = description
    async with get_client() as client:
        return await client.post("/api/graphs/", json=payload)


async def update_flow_metadata(
    flow_id: int,
    name: str | None = None,
    description: str | None = None,
    epicchat_enabled: bool | None = None,
) -> dict[str, Any]:
    """Update flow name, description, or settings. Does not affect nodes or edges."""
    payload: dict[str, Any] = {}
    if name is not None:
        payload["name"] = name
    if description is not None:
        payload["description"] = description
    if epicchat_enabled is not None:
        payload["epicchat_enabled"] = epicchat_enabled
    async with get_client() as client:
        return await client.patch(f"/api/graphs/{flow_id}/", json=payload)


async def get_flow_nodes(flow_id: int) -> dict[str, Any]:
    """Get all node lists for a flow, organised by node type."""
    async with get_client() as client:
        flow = await client.get(f"/api/graphs/{flow_id}/")
    node_keys = [
        k for k in flow
        if k.endswith("_list") or k in ("edge_list", "conditional_edge_list")
    ]
    return {k: flow[k] for k in node_keys}


async def add_node(
    flow_id: int,
    node_type: str,
    config: dict[str, Any],
    node_name: str | None = None,
) -> dict[str, Any]:
    """Add a node to a flow.

    node_type must be one of: crewnode, pythonnode, startnode, endnode,
    subgraphnode, codeagentnode, fileextractornode, audiotranscriptionnode,
    decisiontablenode, telegramtriggernode, webhooktriggernode

    node_name: optional display name for the node.

    config keys by node_type:
      crewnode:   {crew_id: int}
      pythonnode: {python_code: {code: str, entrypoint: str, libraries: list[str]}}
      startnode:  {variables: dict}
      endnode:    {output_map: dict}
    """
    endpoint = NODE_TYPE_TO_ENDPOINT.get(node_type.lower())
    if not endpoint:
        valid = ", ".join(NODE_TYPE_TO_ENDPOINT)
        raise EpicStaffAPIError(
            status_code=400,
            detail=f"Unknown node_type '{node_type}'. Valid types: {valid}",
        )
    payload: dict[str, Any] = {"graph": flow_id, **config}
    if node_name is not None:
        payload["node_name"] = node_name
    async with get_client() as client:
        result = await client.post(f"/api/{endpoint}/", json=payload)
    label = node_name or result.get("node_name") or node_type
    warnings = fv.check_node_config(node_type, config, label)
    warnings.append(
        fv._w("node_not_connected", f"Node '{label}' has no edges yet — wire it next.", label)
    )
    return fv.envelope(
        result,
        what_changed=f"Created {node_type} '{label}'.",
        warnings=warnings,
        suggested_next=[f"add_edge({flow_id}, <from_id>, {result.get('id', '<id>')})"]
        + fv.structural_next_steps(flow_id),
    )


async def update_node(
    flow_id: int,
    node_id: int,
    node_type: str,
    config: dict[str, Any],
) -> dict[str, Any]:
    """Update a node's configuration.

    node_type: same values as add_node
    config: fields to update (node-type specific)
    """
    endpoint = NODE_TYPE_TO_ENDPOINT.get(node_type.lower())
    if not endpoint:
        valid = ", ".join(NODE_TYPE_TO_ENDPOINT)
        raise EpicStaffAPIError(
            status_code=400,
            detail=f"Unknown node_type '{node_type}'. Valid types: {valid}",
        )
    async with get_client() as client:
        return await client.patch(f"/api/{endpoint}/{node_id}/", json=config)


async def delete_node(flow_id: int, node_id: int, node_type: str) -> dict[str, str]:
    """Delete a node from a flow. node_type: same values as add_node."""
    endpoint = NODE_TYPE_TO_ENDPOINT.get(node_type.lower())
    if not endpoint:
        valid = ", ".join(NODE_TYPE_TO_ENDPOINT)
        raise EpicStaffAPIError(
            status_code=400,
            detail=f"Unknown node_type '{node_type}'. Valid types: {valid}",
        )
    async with get_client() as client:
        await client.delete(f"/api/{endpoint}/{node_id}/")
    return {"message": f"Node {node_id} ({node_type}) deleted successfully"}


async def list_edges(flow_id: int) -> dict[str, Any]:
    """List all regular and conditional edges for a flow."""
    async with get_client() as client:
        edges = await client.get("/api/edges/", params={"graph": flow_id})
        conditional = await client.get("/api/conditionaledges/", params={"graph": flow_id})
    return {
        "edges": edges.get("results", []),
        "conditional_edges": conditional.get("results", []),
    }


async def add_edge(
    flow_id: int,
    start_node_id: int,
    end_node_id: int,
) -> dict[str, Any]:
    """Connect two nodes with a regular (unconditional) edge."""
    async with get_client() as client:
        result = await client.post(
            "/api/edges/",
            json={"graph": flow_id, "start_node_id": start_node_id, "end_node_id": end_node_id},
        )
    return fv.envelope(
        result,
        what_changed=f"Connected node {start_node_id} -> {end_node_id}.",
        suggested_next=fv.structural_next_steps(flow_id),
    )


async def delete_edge(
    flow_id: int, edge_id: int, conditional: bool = False
) -> dict[str, str]:
    """Delete an edge. Set conditional=True to delete a conditional edge."""
    endpoint = "conditionaledges" if conditional else "edges"
    async with get_client() as client:
        await client.delete(f"/api/{endpoint}/{edge_id}/")
    return {"message": f"Edge {edge_id} deleted successfully"}


async def copy_flow(flow_id: int, name: str | None = None) -> dict[str, Any]:
    """Create a copy of an existing flow (including all its nodes and edges).

    flow_id: ID of the flow to copy
    name: optional name for the new flow copy; if omitted the server generates one
    """
    payload: dict[str, Any] = {}
    if name is not None:
        payload["name"] = name
    async with get_client() as client:
        return await client.post(f"/api/graphs/{flow_id}/copy/", json=payload)


async def save_flow(
    flow_id: int,
    crew_node_list: list[dict[str, Any]] | None = None,
    python_node_list: list[dict[str, Any]] | None = None,
    start_node_list: list[dict[str, Any]] | None = None,
    end_node_list: list[dict[str, Any]] | None = None,
    subgraph_node_list: list[dict[str, Any]] | None = None,
    code_agent_node_list: list[dict[str, Any]] | None = None,
    file_extractor_node_list: list[dict[str, Any]] | None = None,
    audio_transcription_node_list: list[dict[str, Any]] | None = None,
    decision_table_node_list: list[dict[str, Any]] | None = None,
    telegram_trigger_node_list: list[dict[str, Any]] | None = None,
    webhook_trigger_node_list: list[dict[str, Any]] | None = None,
    edge_list: list[dict[str, Any]] | None = None,
    conditional_edge_list: list[dict[str, Any]] | None = None,
    deleted: dict[str, Any] | None = None,
    allow_incomplete: bool = False,
) -> dict[str, Any]:
    """Atomically save an entire flow graph in one request (bulk save).

    Sends all node lists, edges, and deletions in a single POST to
    /api/graphs/{flow_id}/save/.  Any list omitted (left as None) is sent as an
    empty list, meaning those node types are left untouched.

    Node objects in each list must include a 'graph' field set to flow_id.
    New nodes (not yet in the DB) should omit 'id' or set it to null, and may
    include a 'temp_id' UUID so that edges created in the same request can
    reference them before a real DB id is assigned.

    Edge objects:
      - Regular edges need 'graph', and exactly one of ('start_node_id',
        'start_temp_id') and one of ('end_node_id', 'end_temp_id').
      - Conditional edges need 'graph' and exactly one of ('source_node_id',
        'source_temp_id').

    deleted: dict with keys like 'crew_node_ids', 'edge_ids',
             'conditional_edge_ids', etc. containing lists of IDs to delete.

    GATE: after saving, the flow is re-validated (structure + variable paths). If
    blocker-level problems remain, the envelope reports status="error",
    gate="blocked" — your signal that the flow is not yet runnable. The save has
    already persisted (the bulk POST is atomic and cannot be rolled back), so
    this is a hard *signal*, not a refusal to write. Pass allow_incomplete=True
    to acknowledge a work-in-progress save: blockers are still listed but
    gate="override" and status is downgraded to "warning".
    """
    payload: dict[str, Any] = {
        "crew_node_list": crew_node_list or [],
        "python_node_list": python_node_list or [],
        "start_node_list": start_node_list or [],
        "end_node_list": end_node_list or [],
        "subgraph_node_list": subgraph_node_list or [],
        "code_agent_node_list": code_agent_node_list or [],
        "file_extractor_node_list": file_extractor_node_list or [],
        "audio_transcription_node_list": audio_transcription_node_list or [],
        "decision_table_node_list": decision_table_node_list or [],
        "telegram_trigger_node_list": telegram_trigger_node_list or [],
        "webhook_trigger_node_list": webhook_trigger_node_list or [],
        "edge_list": edge_list or [],
        "conditional_edge_list": conditional_edge_list or [],
        "deleted": deleted or {},
    }
    async with get_client() as client:
        result = await client.post(f"/api/graphs/{flow_id}/save/", json=payload)

    # Re-validate the persisted flow and gate on blocker-level problems.
    structure = await test_flow(flow_id)
    paths = await validate_flow_paths(flow_id)
    warnings: list[dict[str, Any]] = [
        fv._w("structure", issue) for issue in structure.get("issues", [])
    ]
    for f in paths.get("findings", []):
        code = "path_blocker" if f["severity"] == "blocker" else "path_warning"
        warnings.append(fv._w(code, f["message"], f.get("reader_node")))

    has_blocker = (not structure.get("ok", True)) or paths.get("status") == "error"
    if has_blocker and not allow_incomplete:
        gate, status = "blocked", "error"
    elif has_blocker:
        gate, status = "override", "warning"
    else:
        gate, status = "passed", ("warning" if warnings else "ok")

    return fv.envelope(
        result,
        what_changed=f"Saved flow {flow_id} ({structure.get('summary', '')}).",
        warnings=warnings,
        suggested_next=(
            [f"init_flow_metadata({flow_id})"]
            if gate != "blocked"
            else [f"test_flow({flow_id})", f"validate_flow_paths({flow_id})"]
        ),
        extra={"gate": gate, "status": status},
    )


async def delete_flow(flow_id: int) -> dict[str, str]:
    """Delete a flow (graph) by ID."""
    async with get_client() as client:
        await client.delete(f"/api/graphs/{flow_id}/")
    return {"message": f"Flow {flow_id} deleted successfully"}


async def add_conditional_edge(
    flow_id: int,
    source_node_id: int,
    python_code: str,
    input_map: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Add a conditional edge to a flow. The python_code determines routing logic."""
    payload: dict[str, Any] = {
        "graph": flow_id,
        "source_node": source_node_id,
        "python_code": python_code,
    }
    if input_map is not None:
        payload["input_map"] = input_map
    async with get_client() as client:
        result = await client.post("/api/conditionaledges/", json=payload)
    return fv.envelope(
        result,
        what_changed=f"Added conditional edge from node {source_node_id}.",
        suggested_next=fv.structural_next_steps(flow_id),
    )


# Graph Tags
async def list_graph_tags(limit: int = 100, offset: int = 0) -> dict[str, Any]:
    """List all graph (flow) tags."""
    async with get_client() as client:
        return await client.get("/api/graph-tags/", params={"limit": limit, "offset": offset})


async def create_graph_tag(name: str) -> dict[str, Any]:
    """Create a new graph tag."""
    async with get_client() as client:
        return await client.post("/api/graph-tags/", json={"name": name})


async def delete_graph_tag(tag_id: int) -> dict[str, str]:
    """Delete a graph tag by ID."""
    async with get_client() as client:
        await client.delete(f"/api/graph-tags/{tag_id}/")
    return {"message": f"Graph tag {tag_id} deleted successfully"}


# Graph Notes
async def list_graph_notes(
    flow_id: int | None = None,
    limit: int = 100,
    offset: int = 0,
) -> dict[str, Any]:
    """List graph notes, optionally filtered by flow."""
    params: dict[str, Any] = {"limit": limit, "offset": offset}
    if flow_id is not None:
        params["graph"] = flow_id
    async with get_client() as client:
        return await client.get("/api/graph-notes/", params=params)


async def create_graph_note(
    flow_id: int,
    content: str,
    position_x: float | None = None,
    position_y: float | None = None,
) -> dict[str, Any]:
    """Create a note on a flow canvas."""
    payload: dict[str, Any] = {"graph": flow_id, "content": content}
    if position_x is not None:
        payload["position_x"] = position_x
    if position_y is not None:
        payload["position_y"] = position_y
    async with get_client() as client:
        return await client.post("/api/graph-notes/", json=payload)


async def update_graph_note(
    note_id: int,
    content: str | None = None,
    position_x: float | None = None,
    position_y: float | None = None,
) -> dict[str, Any]:
    """Update a graph note's content or position."""
    payload: dict[str, Any] = {}
    if content is not None:
        payload["content"] = content
    if position_x is not None:
        payload["position_x"] = position_x
    if position_y is not None:
        payload["position_y"] = position_y
    async with get_client() as client:
        return await client.patch(f"/api/graph-notes/{note_id}/", json=payload)


async def delete_graph_note(note_id: int) -> dict[str, str]:
    """Delete a graph note by ID."""
    async with get_client() as client:
        await client.delete(f"/api/graph-notes/{note_id}/")
    return {"message": f"Graph note {note_id} deleted successfully"}


# Graph Files
async def list_graph_files(
    flow_id: int | None = None,
    limit: int = 100,
    offset: int = 0,
) -> dict[str, Any]:
    """List files attached to a flow."""
    params: dict[str, Any] = {"limit": limit, "offset": offset}
    if flow_id is not None:
        params["graph"] = flow_id
    async with get_client() as client:
        return await client.get("/api/graph-files/", params=params)


async def upload_graph_file(
    flow_id: int,
    file_content_base64: str,
    filename: str,
) -> dict[str, Any]:
    """Upload a file to a flow. Provide file content as base64-encoded string."""
    import base64

    file_bytes = base64.b64decode(file_content_base64)
    async with get_client() as client:
        return await client.post_multipart(
            "/api/graph-files/",
            files={filename: (filename, file_bytes)},
            data={"graph": str(flow_id)},
        )


async def delete_graph_file(file_id: int) -> dict[str, str]:
    """Delete a graph file by ID."""
    async with get_client() as client:
        await client.delete(f"/api/graph-files/{file_id}/")
    return {"message": f"Graph file {file_id} deleted successfully"}


# ---------------------------------------------------------------------------
# NODE_LIST_KEYS: (graph_response_key, api_endpoint)
# ---------------------------------------------------------------------------
NODE_LIST_KEYS: list[tuple[str, str]] = [
    ("start_node_list", "startnodes"),
    ("end_node_list", "endnodes"),
    ("python_node_list", "pythonnodes"),
    ("webhook_trigger_node_list", "webhook-trigger-nodes"),
    ("telegram_trigger_node_list", "telegram-trigger-nodes"),
    ("classification_decision_table_node_list", "classification-decision-table-node"),
    ("decision_table_node_list", "decision-table-node"),
    ("crew_node_list", "crewnodes"),
    ("code_agent_node_list", "code-agent-nodes"),
    ("file_extractor_node_list", "file-extractor-nodes"),
    ("audio_transcription_node_list", "audio-transcription-nodes"),
    ("note_node_list", "note-nodes"),
    ("subgraph_node_list", "subgraph-nodes"),
]

# ---------------------------------------------------------------------------
# Private helpers (not registered as MCP tools — leading underscore)
# ---------------------------------------------------------------------------

async def _resolve_node(
    client: Any,
    graph_id: int,
    name_or_id: str | int,
    list_key_endpoint_pairs: list[tuple[str, str]] | None = None,
) -> tuple[str, int, dict]:
    """Find a node in a graph by name or ID. Returns (endpoint, node_id, node_data)."""
    graph = await client.get(f"/api/graphs/{graph_id}/")
    pairs = list_key_endpoint_pairs if list_key_endpoint_pairs is not None else NODE_LIST_KEYS
    for list_key, endpoint in pairs:
        nodes = graph.get(list_key, [])
        for node in nodes:
            if isinstance(name_or_id, int):
                if node.get("id") == name_or_id:
                    return endpoint, node["id"], node
            else:
                if node.get("node_name") == name_or_id:
                    return endpoint, node["id"], node
    raise ValueError(
        f"Node '{name_or_id}' not found in graph {graph_id}. "
        "Check the name/id and that the node type is included in the search pairs."
    )


async def _get_cdt_node(
    client: Any,
    graph_id: int,
    name_or_id: str | int,
) -> tuple[int, dict]:
    """Find a CDT node by name or ID. Returns (cdt_id, cdt_data)."""
    if isinstance(name_or_id, int):
        data = await client.get(f"/api/classification-decision-table-node/{name_or_id}/")
        return data["id"], data

    nodes = await client.get(
        "/api/classification-decision-table-node/", params={"graph": graph_id}
    )
    results = nodes.get("results", nodes) if isinstance(nodes, dict) else nodes
    for node in results:
        if node.get("node_name") == name_or_id:
            return node["id"], node
    raise ValueError(
        f"CDT node '{name_or_id}' not found in graph {graph_id}."
    )


def _index_graph(graph: dict[str, Any]) -> dict[str, Any]:
    """Index a graph response once into the maps every flow reader needs.

    Returns ``id_to_name``, ``id_to_endpoint``, and ``nodes`` (a list of
    ``{id, name, endpoint, data}``). Centralises the id->name loop that was
    previously copied across get_flow_connections / init_flow_metadata /
    test_flow. The id->name mapping is byte-for-byte what those callers built.
    """
    id_to_name: dict[int, str] = {}
    id_to_endpoint: dict[int, str] = {}
    nodes: list[dict[str, Any]] = []
    for list_key, endpoint in NODE_LIST_KEYS:
        for node in graph.get(list_key, []):
            nid = node.get("id")
            name = node.get("node_name") or node.get("name", str(nid))
            if nid is not None:
                id_to_name[nid] = name
                id_to_endpoint[nid] = endpoint
                nodes.append(
                    {"id": nid, "name": name, "endpoint": endpoint, "data": node}
                )
    return {"id_to_name": id_to_name, "id_to_endpoint": id_to_endpoint, "nodes": nodes}


# ---------------------------------------------------------------------------
# New public tool functions
# ---------------------------------------------------------------------------

async def get_flow_connections(graph_id: int) -> dict[str, Any]:
    """Get all connections in a flow: edges, conditional edges, and CDT/DT routing."""
    async with get_client() as client:
        graph = await client.get(f"/api/graphs/{graph_id}/")

    id_to_name = _index_graph(graph)["id_to_name"]

    edges = []
    for e in graph.get("edge_list", []):
        edges.append({
            "id": e.get("id"),
            "from": id_to_name.get(e.get("start_node_id"), e.get("start_node_id")),
            "to": id_to_name.get(e.get("end_node_id"), e.get("end_node_id")),
        })

    conditional_edges = []
    for e in graph.get("conditional_edge_list", []):
        conditional_edges.append({
            "id": e.get("id"),
            "from": id_to_name.get(e.get("source_node_id") or e.get("source_node"), e.get("source_node_id")),
            "to": id_to_name.get(e.get("target_node_id") or e.get("target_node"), e.get("target_node_id")),
            "condition": e.get("python_code"),
        })

    cdt_routing = []
    for node in graph.get("classification_decision_table_node_list", []):
        groups = [
            {"group_name": g.get("group_name"), "next_node": g.get("next_node")}
            for g in node.get("condition_groups", [])
        ]
        cdt_routing.append({
            "node": node.get("node_name"),
            "groups": groups,
            "default": node.get("default_next_node"),
            "error": node.get("next_error_node"),
        })

    dt_routing = []
    for node in graph.get("decision_table_node_list", []):
        groups = [
            {"group_name": g.get("group_name"), "next_node": g.get("next_node")}
            for g in node.get("condition_groups", [])
        ]
        dt_routing.append({
            "node": node.get("node_name"),
            "groups": groups,
            "default": node.get("default_next_node"),
            "error": node.get("next_error_node"),
        })

    return {
        "edges": edges,
        "conditional_edges": conditional_edges,
        "cdt_routing": cdt_routing,
        "dt_routing": dt_routing,
    }


# Endpoints that are exempt from the "must be wired with edges" expectation.
_EDGELESS_ENDPOINTS = frozenset(
    {
        "decision-table-node",
        "classification-decision-table-node",
        "webhook-trigger-nodes",
        "telegram-trigger-nodes",
    }
)
_TRIGGER_ENDPOINTS = frozenset({"webhook-trigger-nodes", "telegram-trigger-nodes"})
_START_ENDPOINTS = frozenset({"startnodes"})
_END_ENDPOINTS = frozenset({"endnodes"})


async def describe_flow(graph_id: int, fmt: str = "text") -> dict[str, Any]:
    """Human/Claude-readable view of an assembled flow.

    Renders nodes, what each reads/writes, the wiring (edges + CDT/DT routing),
    and flags orphans (nothing reaches them) and dangling nodes (they go
    nowhere) — so you can SEE the flow instead of parsing raw node JSON.

    fmt: "text" (default) | "mermaid" | "both". The structured fields
    (summary, nodes, routing, orphans, dangling) are always returned.
    """
    async with get_client() as client:
        graph = await client.get(f"/api/graphs/{graph_id}/")

    idx = _index_graph(graph)
    id_to_name: dict[int, str] = idx["id_to_name"]
    name_to_id = {v: k for k, v in id_to_name.items()}
    nodes = idx["nodes"]

    # Wiring: regular edges (static), conditional edges (dynamic target),
    # CDT/DT routing by node name.
    has_incoming: set[int] = set()
    has_outgoing: set[int] = set()
    edge_pairs: list[tuple[int, int]] = []
    for e in graph.get("edge_list", []):
        sid, eid = e.get("start_node_id"), e.get("end_node_id")
        if sid is not None:
            has_outgoing.add(sid)
        if eid is not None:
            has_incoming.add(eid)
        if sid is not None and eid is not None:
            edge_pairs.append((sid, eid))

    cond_pairs: list[tuple[int, str]] = []
    for e in graph.get("conditional_edge_list", []):
        sid = e.get("source_node_id") or e.get("source_node")
        if sid is not None:
            has_outgoing.add(sid)
            cond_pairs.append((sid, e.get("python_code") or "lambda"))

    routing_edges: list[tuple[int, str, int]] = []  # (src_id, label, dst_id)
    for list_key in (
        "classification_decision_table_node_list",
        "decision_table_node_list",
    ):
        for node in graph.get(list_key, []):
            src_id = node.get("id")
            if src_id is not None:
                targets = [
                    (g.get("group_name") or "", g.get("next_node"))
                    for g in node.get("condition_groups", [])
                ]
                targets.append(("default", node.get("default_next_node")))
                targets.append(("error", node.get("next_error_node")))
                for label, target_name in targets:
                    if not target_name:
                        continue
                    has_outgoing.add(src_id)
                    dst_id = name_to_id.get(target_name)
                    if dst_id is not None:
                        has_incoming.add(dst_id)
                        routing_edges.append((src_id, label, dst_id))

    # Per-node summary + orphan/dangling classification.
    node_views: list[dict[str, Any]] = []
    orphans: list[str] = []
    dangling: list[str] = []
    for n in nodes:
        nid, name, endpoint, data = n["id"], n["name"], n["endpoint"], n["data"]
        reads = sorted((data.get("input_map") or {}).values()) if data.get("input_map") else []
        writes = data.get("output_variable_path")
        incoming = [id_to_name.get(s) for s, e in edge_pairs if e == nid]
        incoming += [id_to_name.get(s) for s, _, d in routing_edges if d == nid]
        outgoing = [id_to_name.get(e) for s, e in edge_pairs if s == nid]
        outgoing += [id_to_name.get(d) for s, _, d in routing_edges if s == nid]
        node_views.append(
            {
                "id": nid,
                "name": name,
                "type": endpoint,
                "reads": reads,
                "writes": writes,
                "incoming": [x for x in incoming if x],
                "outgoing": [x for x in outgoing if x],
            }
        )
        # Orphan: nothing flows in, and it isn't a start or trigger entry point.
        if (
            nid not in has_incoming
            and endpoint not in _START_ENDPOINTS
            and endpoint not in _TRIGGER_ENDPOINTS
        ):
            orphans.append(name)
        # Dangling: nothing flows out, and it isn't an end node.
        if nid not in has_outgoing and endpoint not in _END_ENDPOINTS:
            dangling.append(name)

    summary = {
        "nodes": len(nodes),
        "edges": len(edge_pairs),
        "conditional_edges": len(cond_pairs),
        "cdt_routes": sum(1 for _ in graph.get("classification_decision_table_node_list", [])),
        "dt_routes": sum(1 for _ in graph.get("decision_table_node_list", [])),
        "orphans": len(orphans),
        "dangling": len(dangling),
    }

    result: dict[str, Any] = {
        "graph_id": graph_id,
        "name": graph.get("name"),
        "summary": summary,
        "nodes": node_views,
        "orphans": orphans,
        "dangling": dangling,
    }

    if fmt in ("text", "both"):
        result["text"] = _render_flow_text(result, edge_pairs, routing_edges, id_to_name)
    if fmt in ("mermaid", "both"):
        result["mermaid"] = _render_flow_mermaid(node_views, edge_pairs, cond_pairs, routing_edges)
    return result


def _render_flow_text(
    result: dict[str, Any],
    edge_pairs: list[tuple[int, int]],
    routing_edges: list[tuple[int, str, int]],
    id_to_name: dict[int, str],
) -> str:
    lines: list[str] = [f"Flow: {result['name']} (id={result['graph_id']})"]
    s = result["summary"]
    lines.append(
        f"  {s['nodes']} nodes, {s['edges']} edges, "
        f"{s['conditional_edges']} conditional, {s['orphans']} orphan, "
        f"{s['dangling']} dangling"
    )
    lines.append("Nodes:")
    for n in result["nodes"]:
        reads = f" [reads: {', '.join(n['reads'])}]" if n["reads"] else ""
        writes = f" -> writes: {n['writes']}" if n["writes"] else ""
        lines.append(f"  - {n['name']} ({n['type']}){reads}{writes}")
    if edge_pairs:
        lines.append("Edges:")
        for s_id, e_id in edge_pairs:
            lines.append(f"  {id_to_name.get(s_id, s_id)} -> {id_to_name.get(e_id, e_id)}")
    if routing_edges:
        lines.append("Routing:")
        for s_id, label, d_id in routing_edges:
            lines.append(
                f"  {id_to_name.get(s_id, s_id)} --[{label}]--> {id_to_name.get(d_id, d_id)}"
            )
    if result["orphans"]:
        lines.append(f"Orphans (nothing reaches them): {', '.join(result['orphans'])}")
    if result["dangling"]:
        lines.append(f"Dangling (they go nowhere): {', '.join(result['dangling'])}")
    return "\n".join(lines)


def _render_flow_mermaid(
    node_views: list[dict[str, Any]],
    edge_pairs: list[tuple[int, int]],
    cond_pairs: list[tuple[int, str]],
    routing_edges: list[tuple[int, str, int]],
) -> str:
    def _esc(text: str) -> str:
        return str(text).replace('"', "'")

    lines = ["flowchart TD"]
    orphan_dangling = set()
    for n in node_views:
        lines.append(f'    n{n["id"]}["{_esc(n["name"])}\\n({n["type"]})"]')
        if not n["incoming"] and n["type"] not in ("startnodes",):
            orphan_dangling.add(n["id"])
    for s_id, e_id in edge_pairs:
        lines.append(f"    n{s_id} --> n{e_id}")
    for s_id, label, d_id in routing_edges:
        lines.append(f'    n{s_id} -- "{_esc(label)}" --> n{d_id}')
    return "\n".join(lines)


async def get_cdt_node(graph_id: int, name_or_id: str | int) -> dict[str, Any]:
    """Get full CDT node details: pre/post code, prompts dict, condition groups."""
    async with get_client() as client:
        cdt_id, _ = await _get_cdt_node(client, graph_id, name_or_id)
        return await client.get(f"/api/classification-decision-table-node/{cdt_id}/")


async def get_cdt_prompts(graph_id: int, name_or_id: str | int) -> dict[str, Any]:
    """Get just the prompts dict from a CDT node."""
    async with get_client() as client:
        _, cdt_data = await _get_cdt_node(client, graph_id, name_or_id)
    return {"node_name": cdt_data.get("node_name"), "prompts": cdt_data.get("prompts", {})}


async def get_cdt_route_map(graph_id: int) -> dict[str, Any]:
    """Get routing map for all CDT and DT nodes: which group routes where."""
    async with get_client() as client:
        graph = await client.get(f"/api/graphs/{graph_id}/")

    routing: list[dict[str, Any]] = []

    for node in graph.get("classification_decision_table_node_list", []):
        route_map: dict[str, str | None] = {}
        for g in node.get("condition_groups", []):
            route_map[g.get("group_name", "")] = g.get("next_node")
        routing.append({
            "node_type": "cdt",
            "node_name": node.get("node_name"),
            "node_id": node.get("id"),
            "routing": route_map,
            "default": node.get("default_next_node"),
            "error": node.get("next_error_node"),
        })

    for node in graph.get("decision_table_node_list", []):
        route_map = {}
        for g in node.get("condition_groups", []):
            route_map[g.get("group_name", "")] = g.get("next_node")
        routing.append({
            "node_type": "dt",
            "node_name": node.get("node_name"),
            "node_id": node.get("id"),
            "routing": route_map,
            "default": node.get("default_next_node"),
            "error": node.get("next_error_node"),
        })

    return {"graph_id": graph_id, "routing": routing}


async def patch_python_node(
    graph_id: int,
    name_or_id: str | int,
    code: str,
    libraries: list[str] | None = None,
) -> dict[str, Any]:
    """Update Python node code. IMPORTANT: always include libraries or they will be wiped."""
    async with get_client() as client:
        endpoint, node_id, node_data = await _resolve_node(
            client, graph_id, name_or_id,
            [("python_node_list", "pythonnodes")],
        )
        existing_libs = libraries
        if existing_libs is None:
            existing_libs = (node_data.get("python_code") or {}).get("libraries", [])
        payload = {"python_code": {"code": code, "libraries": existing_libs}}
        result = await client.patch(f"/api/{endpoint}/{node_id}/", json=payload)
    warnings = fv.check_python_node(
        {"node_name": name_or_id, "python_code": payload["python_code"]}
    )
    return fv.envelope(
        result,
        what_changed=f"Updated Python node '{name_or_id}' code"
        + ("" if libraries is not None else " (libraries preserved)") + ".",
        warnings=warnings,
        suggested_next=fv.structural_next_steps(graph_id),
    )


async def patch_webhook_node(
    graph_id: int,
    name_or_id: str | int,
    code: str,
    libraries: list[str] | None = None,
) -> dict[str, Any]:
    """Update Webhook node handler code. Always include libraries to avoid wiping them."""
    async with get_client() as client:
        endpoint, node_id, node_data = await _resolve_node(
            client, graph_id, name_or_id,
            [("webhook_trigger_node_list", "webhook-trigger-nodes")],
        )
        existing_libs = libraries
        if existing_libs is None:
            existing_libs = (node_data.get("python_code") or {}).get("libraries", [])
        payload = {"python_code": {"code": code, "libraries": existing_libs}}
        result = await client.patch(f"/api/{endpoint}/{node_id}/", json=payload)
    warnings = fv.check_python_node(
        {"node_name": name_or_id, "python_code": payload["python_code"]}
    )
    return fv.envelope(
        result,
        what_changed=f"Updated webhook node '{name_or_id}' handler"
        + ("" if libraries is not None else " (libraries preserved)") + ".",
        warnings=warnings,
        suggested_next=fv.structural_next_steps(graph_id),
    )


async def patch_code_agent_node(
    graph_id: int,
    name_or_id: str | int,
    system_prompt: str | None = None,
    stream_handler_code: str | None = None,
    libraries: list[str] | None = None,
    llm_config_id: int | None = None,
    agent_mode: str | None = None,
) -> dict[str, Any]:
    """Update Code Agent node fields. Only provided (non-None) fields are updated."""
    async with get_client() as client:
        endpoint, node_id, node_data = await _resolve_node(
            client, graph_id, name_or_id,
            [("code_agent_node_list", "code-agent-nodes")],
        )
        payload: dict[str, Any] = {}
        if system_prompt is not None:
            payload["system_prompt"] = system_prompt
        if stream_handler_code is not None or libraries is not None:
            existing_code = (node_data.get("python_code") or {})
            new_code = dict(existing_code)
            if stream_handler_code is not None:
                new_code["code"] = stream_handler_code
            if libraries is not None:
                new_code["libraries"] = libraries
            payload["python_code"] = new_code
        if llm_config_id is not None:
            payload["llm_config"] = llm_config_id
        if agent_mode is not None:
            payload["agent_mode"] = agent_mode
        result = await client.patch(f"/api/{endpoint}/{node_id}/", json=payload)
    return fv.envelope(
        result,
        what_changed=f"Updated code-agent node '{name_or_id}' ({', '.join(payload) or 'no fields'}).",
        suggested_next=fv.structural_next_steps(graph_id),
    )


async def patch_node_libraries(
    graph_id: int,
    name_or_id: str | int,
    libraries: list[str],
) -> dict[str, Any]:
    """Update the libraries list for a Python or Webhook node."""
    supported_pairs = [
        ("python_node_list", "pythonnodes"),
        ("webhook_trigger_node_list", "webhook-trigger-nodes"),
    ]
    async with get_client() as client:
        try:
            endpoint, node_id, node_data = await _resolve_node(
                client, graph_id, name_or_id, supported_pairs
            )
        except ValueError:
            raise ValueError(
                f"Node '{name_or_id}' not found among python or webhook nodes in graph {graph_id}. "
                "Only pythonnode and webhooktriggernode support the libraries field."
            )
        existing_code = (node_data.get("python_code") or {}).get("code", "")
        payload = {"python_code": {"code": existing_code, "libraries": libraries}}
        result = await client.patch(f"/api/{endpoint}/{node_id}/", json=payload)
    return fv.envelope(
        result,
        what_changed=f"Set libraries on '{name_or_id}' to {libraries}.",
        suggested_next=fv.structural_next_steps(graph_id),
    )


async def patch_node_metadata(
    graph_id: int,
    name_or_id: str | int,
    position: dict | None = None,
    color: str | None = None,
) -> dict[str, Any]:
    """Update a node's visual metadata (position, color) in the flow editor."""
    async with get_client() as client:
        endpoint, node_id, node_data = await _resolve_node(client, graph_id, name_or_id)
        metadata = dict(node_data.get("metadata") or {})
        if position is not None:
            metadata["position"] = position
        if color is not None:
            metadata["color"] = color
        result = await client.patch(f"/api/{endpoint}/{node_id}/", json={"metadata": metadata})
    return fv.envelope(
        result,
        what_changed=f"Updated visual metadata on '{name_or_id}'.",
    )


async def patch_start_variables(
    graph_id: int,
    variables: dict[str, Any],
) -> dict[str, Any]:
    """Set the start node's input variables namespace.

    `variables` is a nested domain dict (the runtime exposes it as a DotDict and
    nodes read it via dotted `input_map` paths like `variables.request.city`).
    The StartNode.variables model field is a JSONField defaulting to {} — pass a
    dict, not a list.
    """
    async with get_client() as client:
        graph = await client.get(f"/api/graphs/{graph_id}/")
        start_nodes = graph.get("start_node_list", [])
        if not start_nodes:
            raise ValueError(f"No start node found in graph {graph_id}.")
        node_id = start_nodes[0]["id"]
        result = await client.patch(f"/api/startnodes/{node_id}/", json={"variables": variables})
    return fv.envelope(
        result,
        what_changed="Set start-node input variables.",
        suggested_next=[f"validate_flow_paths({graph_id})"],
    )


async def patch_cdt_node(
    graph_id: int,
    name_or_id: str | int,
    pre_computation_code: str | None = None,
    post_computation_code: str | None = None,
    prompts: dict | None = None,
    condition_groups: list[dict] | None = None,
) -> dict[str, Any]:
    """Update CDT node fields. Only provided (non-None) fields are updated.

    IMPORTANT: prompts must be a dict (not list). condition_groups items must NOT contain
    'id' or 'classification_decision_table_node' fields — remove them before passing.
    """
    async with get_client() as client:
        cdt_id, _ = await _get_cdt_node(client, graph_id, name_or_id)
        payload: dict[str, Any] = {}
        if pre_computation_code is not None:
            payload["pre_computation_code"] = pre_computation_code
        if post_computation_code is not None:
            payload["post_computation_code"] = post_computation_code
        if prompts is not None:
            payload["prompts"] = prompts
        if condition_groups is not None:
            clean_groups = [
                {k: v for k, v in g.items() if k not in ("id", "classification_decision_table_node")}
                for g in condition_groups
            ]
            payload["condition_groups"] = clean_groups
        result = await client.patch(
            f"/api/classification-decision-table-node/{cdt_id}/", json=payload
        )
    warnings = fv.check_cdt({"node_name": name_or_id, **payload})
    return fv.envelope(
        result,
        what_changed=f"Updated CDT node '{name_or_id}' ({', '.join(payload) or 'no fields'}).",
        warnings=warnings,
        suggested_next=[f"get_cdt_route_map({graph_id})"] + fv.structural_next_steps(graph_id),
    )


async def patch_dt_node(
    graph_id: int,
    name_or_id: str | int,
    condition_groups: list[dict],
    default_next_node: str | None = None,
    next_error_node: str | None = None,
) -> dict[str, Any]:
    """Update Decision Table node condition groups and routing.

    IMPORTANT: Each condition_group item MUST include 'conditions: []' key —
    the backend calls pop('conditions') and will error if missing.
    """
    async with get_client() as client:
        endpoint, node_id, _ = await _resolve_node(
            client, graph_id, name_or_id,
            [("decision_table_node_list", "decision-table-node")],
        )
        safe_groups = [
            g if "conditions" in g else {**g, "conditions": []}
            for g in condition_groups
        ]
        payload: dict[str, Any] = {"condition_groups": safe_groups}
        if default_next_node is not None:
            payload["default_next_node"] = default_next_node
        if next_error_node is not None:
            payload["next_error_node"] = next_error_node
        result = await client.patch(f"/api/{endpoint}/{node_id}/", json=payload)
    # Validate the groups actually sent (conditions:[] already injected above).
    warnings = fv.check_dt_groups(safe_groups, name_or_id)
    return fv.envelope(
        result,
        what_changed=f"Updated DT node '{name_or_id}' routing.",
        warnings=warnings,
        suggested_next=[f"get_cdt_route_map({graph_id})"] + fv.structural_next_steps(graph_id),
    )


async def init_flow_metadata(graph_id: int) -> dict[str, Any]:
    """Initialize UI positions on all nodes in the flow.

    MUST be called after any structural change (add/delete node or edge).
    Sets each node's metadata field with auto-calculated position, color, icon, size.
    """
    _COLOR_MAP: dict[str, tuple[str, str]] = {
        "startnodes": ("#22c55e", "play"),
        "endnodes": ("#ef4444", "stop"),
        "pythonnodes": ("#3d4251", "code"),
        "crewnodes": ("#8b5cf6", "users"),
        "classification-decision-table-node": ("#f59e0b", "split"),
        "decision-table-node": ("#f59e0b", "table"),
        "webhook-trigger-nodes": ("#06b6d4", "webhook"),
        "telegram-trigger-nodes": ("#06b6d4", "webhook"),
        "code-agent-nodes": ("#3b82f6", "bot"),
    }
    _DEFAULT_COLOR, _DEFAULT_ICON = "#3d4251", "node"

    async with get_client() as client:
        graph = await client.get(f"/api/graphs/{graph_id}/")

        idx = _index_graph(graph)
        id_to_name = idx["id_to_name"]
        all_nodes = idx["nodes"]

        # Build adjacency from edge_list
        adjacency: dict[str, list[str]] = {}
        for e in graph.get("edge_list", []):
            src_name = id_to_name.get(e.get("start_node_id"), "")
            dst_name = id_to_name.get(e.get("end_node_id"), "")
            if src_name and dst_name:
                adjacency.setdefault(src_name, []).append(dst_name)

        # Include CDT -> DT routing as pseudo-edges for layout
        for node in graph.get("classification_decision_table_node_list", []):
            src_name = node.get("node_name", "")
            for g in node.get("condition_groups", []):
                dst = g.get("next_node")
                if dst:
                    adjacency.setdefault(src_name, []).append(dst)

        # BFS layout from __start__
        node_positions: dict[str, tuple[int, int]] = {}
        depth_counts: dict[int, int] = {}
        visited: set[str] = set()

        start_names = [
            n["name"] for n in all_nodes if n["endpoint"] == "startnodes"
        ] or (["__start__"] if "__start__" in {n["name"] for n in all_nodes} else [])

        queue: list[tuple[str, int]] = [(name, 0) for name in start_names]
        for name in start_names:
            visited.add(name)

        while queue:
            current, depth = queue.pop(0)
            slot = depth_counts.get(depth, 0)
            depth_counts[depth] = slot + 1
            node_positions[current] = (depth * 400, slot * 200)
            for neighbor in adjacency.get(current, []):
                if neighbor not in visited:
                    visited.add(neighbor)
                    queue.append((neighbor, depth + 1))

        # Any nodes not reachable from start: place in a column after the rest
        max_depth = max((d for d in depth_counts), default=0) + 1
        stray_slot = 0
        for node_info in all_nodes:
            name = node_info["name"]
            if name not in node_positions:
                node_positions[name] = (max_depth * 400, stray_slot * 200)
                stray_slot += 1

        # Build PATCH coroutines
        async def _patch_node(node_info: dict[str, Any]) -> dict[str, Any]:
            nid = node_info["id"]
            name = node_info["name"]
            endpoint = node_info["endpoint"]
            color, icon = _COLOR_MAP.get(endpoint, (_DEFAULT_COLOR, _DEFAULT_ICON))
            x, y = node_positions.get(name, (0, 0))
            metadata = {
                "position": {"x": x, "y": y},
                "color": color,
                "icon": icon,
                "size": {"width": 180, "height": 50},
                "parentId": None,
            }
            return await client.patch(f"/api/{endpoint}/{nid}/", json={"metadata": metadata})

        results = await asyncio.gather(*[_patch_node(n) for n in all_nodes], return_exceptions=True)

    patched = sum(1 for r in results if not isinstance(r, Exception))
    summary_nodes = []
    for node_info in all_nodes:
        name = node_info["name"]
        x, y = node_positions.get(name, (0, 0))
        summary_nodes.append({"name": name, "type": node_info["endpoint"], "position": {"x": x, "y": y}})

    return {"patched": patched, "nodes": summary_nodes}


async def test_flow(graph_id: int) -> dict[str, Any]:
    """Verify flow structure: all nodes connected, CDT/DT have routing, required fields set.

    Returns {"ok": bool, "issues": [str], "summary": str}
    """
    async with get_client() as client:
        graph = await client.get(f"/api/graphs/{graph_id}/")

    issues: list[str] = []

    # Build id->name map
    idx = _index_graph(graph)
    id_to_name = idx["id_to_name"]
    all_node_ids: set[int] = set(id_to_name)

    # Check __start__
    start_nodes = graph.get("start_node_list", [])
    if not start_nodes:
        issues.append("Flow has no start node.")

    # Check __end__
    end_nodes = graph.get("end_node_list", [])
    if not end_nodes:
        issues.append("Flow has no end node.")

    # Build edge sets
    connected_ids: set[int] = set()
    for e in graph.get("edge_list", []):
        sid = e.get("start_node_id")
        eid = e.get("end_node_id")
        if sid is not None:
            connected_ids.add(sid)
        if eid is not None:
            connected_ids.add(eid)

    # DT node ids (no edges expected)
    dt_ids: set[int] = {
        n["id"] for n in graph.get("decision_table_node_list", []) if n.get("id")
    }
    # Trigger node ids
    trigger_ids: set[int] = set()
    for list_key in ("telegram_trigger_node_list", "webhook_trigger_node_list"):
        for n in graph.get(list_key, []):
            if n.get("id"):
                trigger_ids.add(n["id"])

    exempt_ids = dt_ids | trigger_ids
    for nid in all_node_ids:
        if nid not in exempt_ids and nid not in connected_ids:
            issues.append(
                f"Node '{id_to_name.get(nid, nid)}' (id={nid}) has no edges (disconnected)."
            )

    # CDT routing check
    for node in graph.get("classification_decision_table_node_list", []):
        groups = node.get("condition_groups", [])
        routed = [g for g in groups if g.get("next_node")]
        if not routed:
            issues.append(
                f"CDT node '{node.get('node_name')}' has no condition groups with a next_node."
            )

    # DT routing check
    for node in graph.get("decision_table_node_list", []):
        groups = node.get("condition_groups", [])
        routed = [g for g in groups if g.get("next_node")]
        if not routed:
            issues.append(
                f"DT node '{node.get('node_name')}' has no condition groups with a next_node."
            )

    # Python node code check
    for node in graph.get("python_node_list", []):
        code = (node.get("python_code") or {}).get("code", "")
        if not code or not code.strip():
            issues.append(f"Python node '{node.get('node_name')}' has empty code.")

    ok = len(issues) == 0
    summary = "Flow is valid." if ok else f"{len(issues)} issue(s) found."
    return {"ok": ok, "issues": issues, "summary": summary}


def _normalize_path(path: str) -> str:
    """Strip a leading JSONPath ``$.`` so 'variables.x' and '$.variables.x' match."""
    p = str(path).strip()
    if p.startswith("$."):
        p = p[2:]
    elif p.startswith("$"):
        p = p[1:]
    return p


def _flatten_declared(variables: Any, prefix: str = "variables") -> set[str]:
    """Flatten the start node's variables into dotted paths under ``variables``.

    Handles both shapes seen in the wild: a list of ``{name, ...}`` schema items
    and a nested domain dict (see open question O1). Includes every parent path
    so a reader of ``variables.jira`` is satisfied by a declared
    ``variables.jira.base_url``. The bare ``variables`` root is intentionally
    NOT a declared path — declaring nothing must not satisfy arbitrary reads.
    """
    paths: set[str] = set()
    if isinstance(variables, list):
        for item in variables:
            if isinstance(item, dict) and item.get("name"):
                paths.add(f"{prefix}.{item['name']}")
    elif isinstance(variables, dict):
        for key, val in variables.items():
            child = f"{prefix}.{key}"
            paths.add(child)
            paths |= _flatten_declared(val, child)
    return paths


def _main_params(code: str) -> list[str]:
    """Parameter names of the ``def main(...)`` entrypoint, for implicit maps."""
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == "main":
            return [a.arg for a in node.args.args if a.arg not in ("self", "state")]
    return []


def _satisfied(reader: str, available: set[str]) -> bool:
    """A reader path is satisfied if it, a parent, or a child is available."""
    return any(
        reader == p or reader.startswith(p + ".") or p.startswith(reader + ".")
        for p in available
    )


async def validate_flow_paths(graph_id: int) -> dict[str, Any]:
    """Statically validate input_map / output_map paths against the declared
    start variables plus upstream output_variable_path writers — catching
    undeclared-variable failures before a run.

    Returns {graph_id, status, declared_paths, writers, findings}. A reader fed
    via input_map that resolves nowhere is a blocker (runtime AttributeError);
    one referenced only by the end node's output_map is a warning (silently
    resolves to "not found").
    """
    async with get_client() as client:
        graph = await client.get(f"/api/graphs/{graph_id}/")

    idx = _index_graph(graph)

    declared: set[str] = set()
    for sn in graph.get("start_node_list", []):
        declared |= _flatten_declared(sn.get("variables"))

    # Writers: every output_variable_path across all nodes.
    writers: dict[str, list[str]] = {}
    for n in idx["nodes"]:
        wpath = n["data"].get("output_variable_path")
        if wpath:
            writers.setdefault(_normalize_path(wpath), []).append(n["name"])

    available = declared | set(writers)
    findings: list[dict[str, Any]] = []

    for w_path, w_nodes in writers.items():
        if len(w_nodes) > 1:
            findings.append(
                {
                    "severity": "warning",
                    "path": w_path,
                    "reader_node": None,
                    "message": f"Multiple writers for '{w_path}': {w_nodes}. "
                    "Give each path exactly one writer.",
                    "fix": "Route writes through a single node or split the path.",
                }
            )

    # Readers via input_map (blockers) + implicit python main params.
    for n in idx["nodes"]:
        data = n["data"]
        input_map = data.get("input_map") or {}
        reader_paths = [_normalize_path(v) for v in input_map.values()]
        if not input_map and n["endpoint"] == "pythonnodes":
            code = (data.get("python_code") or {}).get("code", "") or ""
            reader_paths = [f"variables.{p}" for p in _main_params(code)]
        for rp in reader_paths:
            if rp.startswith("variables") and not _satisfied(rp, available):
                findings.append(
                    {
                        "severity": "blocker",
                        "path": rp,
                        "reader_node": n["name"],
                        "message": f"Node '{n['name']}' reads '{rp}', which is neither "
                        "declared in start variables nor written upstream.",
                        "fix": f"Declare '{rp}' in the start node or write it before this node.",
                    }
                )

    # Readers via end node output_map (warnings).
    for en in graph.get("end_node_list", []):
        for key, src in (en.get("output_map") or {}).items():
            rp = _normalize_path(src)
            if rp.startswith("variables") and not _satisfied(rp, available):
                findings.append(
                    {
                        "severity": "warning",
                        "path": rp,
                        "reader_node": en.get("node_name"),
                        "message": f"End node output_map['{key}'] references '{rp}', "
                        "which is never written — it will resolve to \"not found\".",
                        "fix": f"Ensure some node writes '{rp}'.",
                    }
                )

    has_blocker = any(f["severity"] == "blocker" for f in findings)
    status = "error" if has_blocker else ("warning" if findings else "ok")
    return {
        "graph_id": graph_id,
        "status": status,
        "declared_paths": sorted(declared),
        "writers": writers,
        "findings": findings,
    }


async def export_flow(flow_id: int) -> dict[str, Any]:
    """Export a flow as a JSON bundle including all dependencies (agents, crews, tools, etc)."""
    async with get_client() as client:
        return await client.get(f"/api/graphs/{flow_id}/export/")


async def bulk_export_flows(flow_ids: list[int]) -> dict[str, Any]:
    """Export multiple flows as a single JSON bundle including all dependencies."""
    async with get_client() as client:
        return await client.post("/api/graphs/bulk-export/", json={"ids": flow_ids})


async def import_flow(flow_data: dict[str, Any], preserve_uuids: bool = False) -> dict[str, Any]:
    """Import a flow from a previously exported JSON bundle.

    Pass the dict you received from export_flow or bulk_export_flows as flow_data.
    Returns a summary of created/updated entities.
    """
    import json as _json
    file_bytes = _json.dumps(flow_data).encode()
    async with get_client() as client:
        return await client.post_multipart(
            "/api/graphs/import/",
            files={"file": ("flow.json", file_bytes, "application/json")},
            data={"preserve_uuids": str(preserve_uuids).lower()},
        )
