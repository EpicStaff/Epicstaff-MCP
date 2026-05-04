"""MCP tools for managing EpicStaff flows (visual workflows) including nodes and edges."""
from __future__ import annotations

import asyncio
from typing import Any

from epicstaff_mcp.client import get_client
from epicstaff_mcp.exceptions import EpicStaffAPIError

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
        return await client.post(f"/api/{endpoint}/", json=payload)


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
        return await client.post(
            "/api/edges/",
            json={"graph": flow_id, "start_node_id": start_node_id, "end_node_id": end_node_id},
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
        return await client.post(f"/api/graphs/{flow_id}/save/", json=payload)


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
        return await client.post("/api/conditionaledges/", json=payload)


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


# ---------------------------------------------------------------------------
# New public tool functions
# ---------------------------------------------------------------------------

async def get_flow_connections(graph_id: int) -> dict[str, Any]:
    """Get all connections in a flow: edges, conditional edges, and CDT/DT routing."""
    async with get_client() as client:
        graph = await client.get(f"/api/graphs/{graph_id}/")

    id_to_name: dict[int, str] = {}
    for list_key, _ in NODE_LIST_KEYS:
        for node in graph.get(list_key, []):
            nid = node.get("id")
            name = node.get("node_name") or node.get("name", str(nid))
            if nid is not None:
                id_to_name[nid] = name

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
        return await client.patch(f"/api/{endpoint}/{node_id}/", json=payload)


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
        return await client.patch(f"/api/{endpoint}/{node_id}/", json=payload)


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
        return await client.patch(f"/api/{endpoint}/{node_id}/", json=payload)


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
        return await client.patch(f"/api/{endpoint}/{node_id}/", json=payload)


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
        return await client.patch(f"/api/{endpoint}/{node_id}/", json={"metadata": metadata})


async def patch_start_variables(
    graph_id: int,
    variables: list[dict],
) -> dict[str, Any]:
    """Set the start node's input variables definition."""
    async with get_client() as client:
        graph = await client.get(f"/api/graphs/{graph_id}/")
        start_nodes = graph.get("start_node_list", [])
        if not start_nodes:
            raise ValueError(f"No start node found in graph {graph_id}.")
        node_id = start_nodes[0]["id"]
        return await client.patch(f"/api/startnodes/{node_id}/", json={"variables": variables})


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
        return await client.patch(
            f"/api/classification-decision-table-node/{cdt_id}/", json=payload
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
        return await client.patch(f"/api/{endpoint}/{node_id}/", json=payload)


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

        # Build id->name, id->endpoint, and name->node maps
        id_to_name: dict[int, str] = {}
        id_to_endpoint: dict[int, str] = {}
        all_nodes: list[dict[str, Any]] = []

        for list_key, endpoint in NODE_LIST_KEYS:
            for node in graph.get(list_key, []):
                nid = node.get("id")
                name = node.get("node_name") or node.get("name", str(nid))
                if nid is not None:
                    id_to_name[nid] = name
                    id_to_endpoint[nid] = endpoint
                    all_nodes.append({"id": nid, "name": name, "endpoint": endpoint, "data": node})

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
    id_to_name: dict[int, str] = {}
    all_node_ids: set[int] = set()
    for list_key, _ in NODE_LIST_KEYS:
        for node in graph.get(list_key, []):
            nid = node.get("id")
            name = node.get("node_name") or node.get("name", str(nid))
            if nid is not None:
                id_to_name[nid] = name
                all_node_ids.add(nid)

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
