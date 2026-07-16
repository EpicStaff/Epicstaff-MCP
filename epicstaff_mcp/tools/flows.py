"""MCP tools for managing EpicStaff flows (visual workflows) including nodes and edges."""

from __future__ import annotations

import ast
import asyncio
import itertools
import re
import sys
from copy import deepcopy
from types import SimpleNamespace
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
    "classificationdecisiontablenode": "classification-decision-table-node",
    "telegramtriggernode": "telegram-trigger-nodes",
    "webhooktriggernode": "webhook-trigger-nodes",
    "scheduletriggernode": "schedule-trigger-nodes",
    # CrewAI-replacement nodes — one AgentDefinition run by the standalone agent
    # microservice (no crew). AgentNode = ordered list of sub-tasks; TaskNode = single task.
    "agentnode": "agentnodes",
    "tasknode": "tasknodes",
}

# Deprecated node types — still executed by the current EpicStaff, but slated for
# removal in favor of the standalone-agent primitives (agentnode / tasknode). Creation
# is NOT blocked; callers get a soft warning steering them to the replacement.
_DEPRECATION_REPLACEMENT = (
    "Use agentnode (single agent with ordered inline tasks) or tasknode (one task) "
    "instead — the standalone agent microservice that replaces it. Still runs in the "
    "current EpicStaff but is slated for removal."
)
_DEPRECATED_NODE_TYPES: dict[str, str] = {
    "codeagentnode": f"'codeagentnode' (Code Agent) is deprecated. {_DEPRECATION_REPLACEMENT}",
    "crewnode": f"'crewnode' (Crew/Project) is deprecated. {_DEPRECATION_REPLACEMENT}",
}
# Same concept keyed by the DSL spec `type` discriminator (create_flow_from_spec).
_DEPRECATED_SPEC_TYPES: dict[str, str] = {
    "code_agent": f"'code_agent' (Code Agent) is deprecated. {_DEPRECATION_REPLACEMENT}",
    "crew": f"'crew' (Crew/Project) is deprecated. {_DEPRECATION_REPLACEMENT}",
}


def _deprecation_note(node_type: str) -> str | None:
    """Return the deprecation message for a node_type (add_node form), or None."""
    return _DEPRECATED_NODE_TYPES.get((node_type or "").lower())


def _spec_deprecation_note(spec_type: str) -> str | None:
    """Return the deprecation message for a DSL spec `type`, or None."""
    return _DEPRECATED_SPEC_TYPES.get((spec_type or "").lower())


async def list_flows(
    limit: int = 100,
    offset: int = 0,
    search: str | None = None,
    label_id: int | None = None,
    no_label: bool = False,
    epicchat_enabled: bool | None = None,
) -> dict[str, Any]:
    """List all flows (lightweight — no node detail).

    Supports pagination, search, and optional filters:
      label_id: only flows tagged with this label id
      no_label: only flows without any label
      epicchat_enabled: filter by EpicChat enabled state
    """
    params: dict[str, Any] = {"limit": limit, "offset": offset}
    if search:
        params["search"] = search
    if label_id is not None:
        params["label_id"] = label_id
    if no_label:
        params["no_label"] = "true"
    if epicchat_enabled is not None:
        params["epicchat_enabled"] = str(epicchat_enabled).lower()
    async with get_client() as client:
        return await client.get("/api/graph-light/", params=params)


def _graph_id_to_name(graph: dict[str, Any]) -> dict[int, str]:
    """Build an id -> node_name map across every node list in a graph."""
    id_to_name: dict[int, str] = {}
    for list_key, _ in NODE_LIST_KEYS:
        for node in graph.get(list_key, []):
            node_id = node.get("id")
            if node_id is not None:
                id_to_name[node_id] = node.get("node_name") or node.get(
                    "name", str(node_id)
                )
    return id_to_name


def _backfill_cdt_route_names(graph: dict[str, Any]) -> None:
    """Fill the read-only display-name fields on CDT/DT routing in place.

    The backend routes by integer `*_id` but returns the paired NAME fields
    (`next_node`, `default_next_node`, `next_error_node`) as null, which reads
    as "unwired" to a human inspecting a flow even though routing works. This
    resolves each id back to its node name so introspection reflects the real
    wiring. Only null/absent name fields are filled — never an existing value.
    """
    id_to_name = _graph_id_to_name(graph)
    for list_key in (
        "classification_decision_table_node_list",
        "decision_table_node_list",
    ):
        for node in graph.get(list_key, []):
            for id_field, name_field in (
                ("default_next_node_id", "default_next_node"),
                ("next_error_node_id", "next_error_node"),
            ):
                if not node.get(name_field) and node.get(id_field) in id_to_name:
                    node[name_field] = id_to_name[node[id_field]]
            for group in node.get("condition_groups", []):
                if (
                    not group.get("next_node")
                    and group.get("next_node_id") in id_to_name
                ):
                    group["next_node"] = id_to_name[group["next_node_id"]]


async def get_flow(flow_id: int) -> dict[str, Any]:
    """Get full flow details including all nodes and edges.

    CDT/DT routing display names (`next_node` per group, `default_next_node`,
    `next_error_node`) are backfilled from the node id map — the backend routes
    by integer id and returns those name fields null, which otherwise reads as
    unwired.
    """
    async with get_client() as client:
        graph = await client.get(f"/api/graphs/{flow_id}/")
    _backfill_cdt_route_names(graph)
    return graph


async def create_flow(
    name: str,
    description: str | None = None,
    epicchat_enabled: bool = False,
    persistent_variables: bool | None = None,
) -> dict[str, Any]:
    """Create a new empty flow.

    persistent_variables: opt the flow into cross-session variable persistence
    (the start node's variables then declare the persisted paths).
    """
    payload: dict[str, Any] = {"name": name, "epicchat_enabled": epicchat_enabled}
    if description is not None:
        payload["description"] = description
    if persistent_variables is not None:
        payload["persistent_variables"] = persistent_variables
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
        k
        for k in flow
        if k.endswith("_list") or k in ("edge_list", "conditional_edge_list")
    ]
    return {k: flow[k] for k in node_keys}


async def add_node(
    flow_id: int,
    node_type: str,
    config: dict[str, Any],
    node_name: str | None = None,
    sync_metadata: bool = True,
) -> dict[str, Any]:
    """Add a node to a flow.

    node_type must be one of: crewnode, pythonnode, startnode, endnode,
    subgraphnode, codeagentnode, fileextractornode, audiotranscriptionnode,
    decisiontablenode, classificationdecisiontablenode, telegramtriggernode,
    webhooktriggernode, scheduletriggernode, agentnode, tasknode

    DEPRECATED (still executes, slated for removal): `codeagentnode` (Code Agent)
    and `crewnode` (Crew/Project). Prefer `agentnode` (single agent, ordered inline
    tasks) or `tasknode` (one task) — the standalone agent microservice that replaces
    them. Creating either still works but returns a `deprecation_warning`.

    Prefer classificationdecisiontablenode (CDT) over decisiontablenode (DT):
    CDT is a deterministic superset (routes on a group `expression` with no LLM
    unless a group sets `prompt_id`) and avoids the DT viewset's crash on stray
    fields. Wire CDT routing with patch_cdt_node (next_node_id per group).

    agentnode / tasknode run a single AgentDefinition on the standalone agent
    microservice (the CrewAI replacement) — no crew. They attach reusable Surfaces
    (tool/knowledge/storage bundles). Never send a `ports` field for these.

    node_name: optional display name for the node.

    config keys by node_type:
      crewnode:   {crew_id: int}
      pythonnode: {python_code: {code: str, entrypoint: str, libraries: list[str]}}
      startnode:  {variables: dict}
      endnode:    {output_map: dict}
      subgraphnode: {subgraph: int (or subgraph_id alias), input_map, output_variable_path}
      tasknode:   {agent_definition: int (or agent_definition_id alias), surface_list: [int],
                   inline_surface: dict, instructions: str (the prompt), output_schema: dict,
                   remember_output: bool, input_map: dict, output_variable_path: str}
      agentnode:  {agent_definition, surface_list, inline_surface, input_map,
                   output_variable_path, tasks: [{name, order, instructions,
                   temp_id?, context_task_temp_ids?}]}  # ordered sub-tasks, inline
      scheduletriggernode: {node_name (REQUIRED — no auto-gen), is_active: bool,
                   schedule: {run_mode: "once"|"repeat", timezone, start_date_time,
                   interval: {every, unit, weekdays}, end: {type, ...}}}  # is itself an
                   entrypoint — wire outgoing edges FROM it

    sync_metadata: after a successful add, runs init_flow_metadata(flow_id) so
    the new node doesn't render as an unstyled "black dot". Default True;
    pass False when batching several structural writes and syncing once at
    the end yourself.
    """
    endpoint = NODE_TYPE_TO_ENDPOINT.get(node_type.lower())
    if not endpoint:
        valid = ", ".join(NODE_TYPE_TO_ENDPOINT)
        raise EpicStaffAPIError(
            status_code=400,
            detail=f"Unknown node_type '{node_type}'. Valid types: {valid}",
        )
    normalized = dict(config)
    # A subgraph node's FK field is `subgraph`; accept `subgraph_id` as an alias
    # so callers aren't silently left with an unlinked node.
    if (
        node_type.lower() == "subgraphnode"
        and "subgraph" not in normalized
        and "subgraph_id" in normalized
    ):
        normalized["subgraph"] = normalized.pop("subgraph_id")
    # agent/task nodes reference an AgentDefinition via `agent_definition`; accept
    # the `agent_definition_id` alias for the same reason.
    if (
        node_type.lower() in ("agentnode", "tasknode")
        and "agent_definition" not in normalized
        and "agent_definition_id" in normalized
    ):
        normalized["agent_definition"] = normalized.pop("agent_definition_id")
    payload: dict[str, Any] = {"graph": flow_id, **normalized}
    if node_name is not None:
        payload["node_name"] = node_name
    async with get_client() as client:
        result = await client.post(f"/api/{endpoint}/", json=payload)
    if sync_metadata:
        await init_flow_metadata(flow_id)
    note = _deprecation_note(node_type)
    if note and isinstance(result, dict):
        result = {**result, "deprecation_warning": note}
    return result


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


async def delete_node(
    flow_id: int, node_id: int, node_type: str, sync_metadata: bool = True
) -> dict[str, str]:
    """Delete a node from a flow. node_type: same values as add_node.

    sync_metadata: after a successful delete, runs init_flow_metadata(flow_id)
    to re-lay-out the remaining nodes. Default True; pass False when batching.
    """
    endpoint = NODE_TYPE_TO_ENDPOINT.get(node_type.lower())
    if not endpoint:
        valid = ", ".join(NODE_TYPE_TO_ENDPOINT)
        raise EpicStaffAPIError(
            status_code=400,
            detail=f"Unknown node_type '{node_type}'. Valid types: {valid}",
        )
    async with get_client() as client:
        await client.delete(f"/api/{endpoint}/{node_id}/")
    if sync_metadata:
        await init_flow_metadata(flow_id)
    return {"message": f"Node {node_id} ({node_type}) deleted successfully"}


async def add_agent_node_task(
    agent_node_id: int,
    name: str,
    order: int,
    instructions: str = "",
    output_schema: dict[str, Any] | None = None,
    context_tasks: list[int] | None = None,
) -> dict[str, Any]:
    """Add a sub-task to an existing AgentNode.

    AgentNode sub-tasks are usually created inline via add_node("agentnode",
    {tasks: [...]}). Use this to append a task to an AgentNode that already exists.

    order must be unique within the AgentNode. context_tasks is a list of existing
    AgentNodeTask ids (same AgentNode, each with a strictly lower order) whose output
    is injected as context for this task.
    """
    payload: dict[str, Any] = {
        "agent_node": agent_node_id,
        "name": name,
        "order": order,
        "instructions": instructions,
    }
    if output_schema is not None:
        payload["output_schema"] = output_schema
    if context_tasks:
        payload["context_tasks"] = context_tasks
    async with get_client() as client:
        return await client.post("/api/agentnodetasks/", json=payload)


async def list_edges(flow_id: int) -> dict[str, Any]:
    """List all regular and conditional edges for a flow."""
    async with get_client() as client:
        edges = await client.get("/api/edges/", params={"graph": flow_id})
        conditional = await client.get(
            "/api/conditionaledges/", params={"graph": flow_id}
        )
    return {
        "edges": edges.get("results", []),
        "conditional_edges": conditional.get("results", []),
    }


async def add_edge(
    flow_id: int,
    start_node_id: int,
    end_node_id: int,
    sync_metadata: bool = True,
) -> dict[str, Any]:
    """Connect two nodes with a regular (unconditional) edge.

    sync_metadata: after a successful add, runs init_flow_metadata(flow_id).
    Default True; pass False when batching several structural writes.
    """
    async with get_client() as client:
        result = await client.post(
            "/api/edges/",
            json={
                "graph": flow_id,
                "start_node_id": start_node_id,
                "end_node_id": end_node_id,
            },
        )
    if sync_metadata:
        await init_flow_metadata(flow_id)
    return result


async def delete_edge(
    flow_id: int,
    edge_id: int,
    conditional: bool = False,
    sync_metadata: bool = True,
) -> dict[str, str]:
    """Delete an edge. Set conditional=True to delete a conditional edge.

    sync_metadata: after a successful delete, runs init_flow_metadata(flow_id).
    Default True; pass False when batching several structural writes.
    """
    endpoint = "conditionaledges" if conditional else "edges"
    async with get_client() as client:
        await client.delete(f"/api/{endpoint}/{edge_id}/")
    if sync_metadata:
        await init_flow_metadata(flow_id)
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
    classification_decision_table_node_list: list[dict[str, Any]] | None = None,
    telegram_trigger_node_list: list[dict[str, Any]] | None = None,
    webhook_trigger_node_list: list[dict[str, Any]] | None = None,
    schedule_trigger_node_list: list[dict[str, Any]] | None = None,
    agent_node_list: list[dict[str, Any]] | None = None,
    task_node_list: list[dict[str, Any]] | None = None,
    graph_note_list: list[dict[str, Any]] | None = None,
    edge_list: list[dict[str, Any]] | None = None,
    conditional_edge_list: list[dict[str, Any]] | None = None,
    deleted: dict[str, Any] | None = None,
    save_version: int | None = None,
    sync_metadata: bool = True,
) -> dict[str, Any]:
    """Atomically save an entire flow graph in one request (bulk save).

    Sends all node lists, edges, and deletions in a single POST to
    /api/graphs/{flow_id}/save/.  Any list omitted (left as None) is sent as an
    empty list, meaning those node types are left untouched.

    Node objects in each list must include a 'graph' field set to flow_id.
    New nodes (not yet in the DB) should omit 'id' or set it to null, and may
    include a 'temp_id' UUID so that edges created in the same request can
    reference them before a real DB id is assigned. CDT/DT nodes may likewise
    route to same-request nodes via 'default_next_node_temp_id',
    'next_error_node_temp_id', and per-group 'next_node_temp_id'.

    Edge objects:
      - Regular edges need 'graph', and exactly one of ('start_node_id',
        'start_temp_id') and one of ('end_node_id', 'end_temp_id').
      - Conditional edges need 'graph' and exactly one of ('source_node_id',
        'source_temp_id').

    deleted: dict with keys like 'crew_node_ids', 'edge_ids',
             'conditional_edge_ids', etc. containing lists of IDs to delete.

    save_version: the flow's current save_version (optimistic lock — the
    backend rejects a mismatch with 409). When omitted, it is fetched from the
    flow automatically; pass it explicitly when you already hold it to save a
    request.

    sync_metadata: after a successful save, runs init_flow_metadata(flow_id)
    so new/moved nodes don't render as unstyled "black dots". Default True;
    pass False when batching further structural writes.
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
        "classification_decision_table_node_list": classification_decision_table_node_list
        or [],
        "telegram_trigger_node_list": telegram_trigger_node_list or [],
        "webhook_trigger_node_list": webhook_trigger_node_list or [],
        "schedule_trigger_node_list": schedule_trigger_node_list or [],
        "agent_node_list": agent_node_list or [],
        "task_node_list": task_node_list or [],
        "graph_note_list": graph_note_list or [],
        "edge_list": edge_list or [],
        "conditional_edge_list": conditional_edge_list or [],
        "deleted": deleted or {},
    }
    async with get_client() as client:
        if save_version is None:
            graph = await client.get(f"/api/graphs/{flow_id}/")
            save_version = graph.get("save_version")
        if save_version is not None:
            payload["save_version"] = save_version
        result = await client.post(f"/api/graphs/{flow_id}/save/", json=payload)
    if sync_metadata:
        await init_flow_metadata(flow_id)
    return result


async def delete_flow(flow_id: int) -> dict[str, str]:
    """Delete a flow (graph) by ID."""
    async with get_client() as client:
        await client.delete(f"/api/graphs/{flow_id}/")
    return {"message": f"Flow {flow_id} deleted successfully"}


async def add_conditional_edge(
    flow_id: int,
    source_node_id: int,
    code: str,
    entrypoint: str = "main",
    libraries: list[str] | None = None,
    input_map: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Add a conditional edge to a flow.

    Routing is decided by python_code, sent as a nested code object
    ({code, entrypoint, libraries}). The code MUST return a string naming the
    target node in "<node_name> #<id>" form (e.g. "Activity Logger #75") — this
    is the key the runtime routes on. Returning a bare name ends the graph
    silently; returning an int raises "output should be a string".
    """
    payload: dict[str, Any] = {
        "graph": flow_id,
        "source_node_id": source_node_id,
        "python_code": {
            "code": code,
            "entrypoint": entrypoint,
            "libraries": libraries or [],
        },
    }
    if input_map is not None:
        payload["input_map"] = input_map
    async with get_client() as client:
        return await client.post("/api/conditionaledges/", json=payload)


# Graph Tags
async def list_graph_tags(limit: int = 100, offset: int = 0) -> dict[str, Any]:
    """List all graph (flow) tags."""
    async with get_client() as client:
        return await client.get(
            "/api/graph-tags/", params={"limit": limit, "offset": offset}
        )


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


# Graph Versions
async def list_graph_versions(flow_id: int) -> dict[str, Any]:
    """List saved versions (snapshots) of a flow, newest first."""
    async with get_client() as client:
        return await client.get("/api/graph-versions/", params={"graph_id": flow_id})


async def get_graph_version(version_id: int) -> dict[str, Any]:
    """Get a single graph version by ID."""
    async with get_client() as client:
        return await client.get(f"/api/graph-versions/{version_id}/")


async def save_graph_version(
    flow_id: int,
    name: str,
    description: str | None = None,
) -> dict[str, Any]:
    """Save the current state of a flow as a new named version (snapshot)."""
    payload: dict[str, Any] = {"graph_id": flow_id, "name": name}
    if description is not None:
        payload["description"] = description
    async with get_client() as client:
        return await client.post("/api/graph-versions/", json=payload)


async def update_graph_version(
    version_id: int,
    name: str | None = None,
    description: str | None = None,
) -> dict[str, Any]:
    """Update a graph version's name or description."""
    payload: dict[str, Any] = {}
    if name is not None:
        payload["name"] = name
    if description is not None:
        payload["description"] = description
    async with get_client() as client:
        return await client.patch(f"/api/graph-versions/{version_id}/", json=payload)


async def restore_graph_version(
    version_id: int,
    save_version: int,
    backup: bool = True,
) -> dict[str, Any]:
    """Restore a flow to a saved version.

    save_version is the expected current version number (optimistic lock).
    backup=True snapshots the current state before restoring.
    """
    params = {"backup": "true"} if backup else None
    async with get_client() as client:
        return await client.post(
            f"/api/graph-versions/{version_id}/restore/",
            json={"save_version": save_version},
            params=params,
        )


async def create_graph_from_version(version_id: int) -> dict[str, Any]:
    """Create a brand-new flow (graph) from a saved version snapshot."""
    async with get_client() as client:
        return await client.post(
            f"/api/graph-versions/{version_id}/create-graph/", json={}
        )


# Graph run status & schedule triggers
async def get_graph_run_status(run_id: str) -> dict[str, Any]:
    """Get the execution status of a graph run by its run ID."""
    async with get_client() as client:
        return await client.get(f"/api/graph_runs/{run_id}/status/")


async def get_schedule_trigger_node(node_id: int) -> dict[str, Any]:
    """Get a schedule trigger node by ID."""
    async with get_client() as client:
        return await client.get(f"/api/schedule-trigger-nodes/{node_id}/")


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
    ("agent_node_list", "agentnodes"),
    ("task_node_list", "tasknodes"),
    ("schedule_trigger_node_list", "schedule-trigger-nodes"),
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
    pairs = (
        list_key_endpoint_pairs
        if list_key_endpoint_pairs is not None
        else NODE_LIST_KEYS
    )
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
        data = await client.get(
            f"/api/classification-decision-table-node/{name_or_id}/"
        )
        return data["id"], data

    nodes = await client.get(
        "/api/classification-decision-table-node/", params={"graph": graph_id}
    )
    results = nodes.get("results", nodes) if isinstance(nodes, dict) else nodes
    for node in results:
        if node.get("node_name") == name_or_id:
            return node["id"], node
    raise ValueError(f"CDT node '{name_or_id}' not found in graph {graph_id}.")


# Fields that exist on ConditionGroup (plain DT) but NOT on
# ClassificationConditionGroup (CDT) — see graph_models.py. The CDT viewset
# splats a group dict straight into the model constructor after blacklisting
# only 'id'/'classification_decision_table_node'; any of these crashes it with
# an unhandled TypeError -> 500 (mcp-usage-issues.md finding F).
_CDT_GROUP_FORBIDDEN_KEYS: frozenset[str] = frozenset({"conditions", "group_type"})


def _validate_condition_groups(
    condition_groups: list[dict[str, Any]], *, node_kind: str
) -> None:
    """Pre-flight reject known CDT/DT condition_group crashers.

    node_kind: "cdt" (ClassificationConditionGroup) or "dt" (ConditionGroup).
    Both backend viewsets construct the model with **group_data after only a
    minimal blacklist; a field the model doesn't have raises a bare TypeError
    that escapes as an unhandled 500 (mcp-usage-issues.md findings B and F).
    Raises EpicStaffAPIError(400, ...) instead of letting the request reach
    the backend, so the caller gets an actionable message instead of a
    500 / dropped connection.
    """
    for group in condition_groups:
        group_name = group.get("group_name", "?")
        next_node_name = group.get("next_node")
        next_node_id = group.get("next_node_id")
        if next_node_name and not isinstance(next_node_id, int):
            raise EpicStaffAPIError(
                status_code=400,
                detail=(
                    f"Condition group '{group_name}' sets 'next_node': "
                    f"{next_node_name!r} but no integer 'next_node_id'. Routing "
                    "is metadata-based on integer node ids only — 'next_node' "
                    "is a read-only display name, never a settable field."
                ),
                remediation=(
                    "Resolve the target node's numeric id (get_flow_nodes or "
                    "get_flow_connections) and set 'next_node_id' to that "
                    "integer instead of (or alongside) 'next_node'."
                ),
            )
        if node_kind == "cdt":
            stray = _CDT_GROUP_FORBIDDEN_KEYS & group.keys()
            if stray:
                raise EpicStaffAPIError(
                    status_code=400,
                    detail=(
                        f"Condition group '{group_name}' has field(s) "
                        f"{sorted(stray)}, which are not valid on a CDT group."
                    ),
                    remediation=(
                        "ClassificationConditionGroup (CDT) has no 'conditions' "
                        "or 'group_type' field — those belong to plain "
                        "decisiontablenode groups only. Send only: group_name, "
                        "order, expression, prompt_id, manipulation, "
                        "continue_flag, next_node_id, dock_visible, "
                        "field_expressions, field_manipulations, route_code, "
                        "section."
                    ),
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
        edges.append(
            {
                "id": e.get("id"),
                "from": id_to_name.get(e.get("start_node_id"), e.get("start_node_id")),
                "to": id_to_name.get(e.get("end_node_id"), e.get("end_node_id")),
            }
        )

    conditional_edges = []
    for e in graph.get("conditional_edge_list", []):
        conditional_edges.append(
            {
                "id": e.get("id"),
                "from": id_to_name.get(
                    e.get("source_node_id"), e.get("source_node_id")
                ),
                "python_code": e.get("python_code"),
            }
        )

    cdt_routing = []
    for node in graph.get("classification_decision_table_node_list", []):
        groups = [
            {
                "group_name": g.get("group_name"),
                "next_node": id_to_name.get(
                    g.get("next_node_id"), g.get("next_node_id")
                ),
            }
            for g in node.get("condition_groups", [])
        ]
        cdt_routing.append(
            {
                "node": node.get("node_name"),
                "groups": groups,
                "default": id_to_name.get(
                    node.get("default_next_node_id"), node.get("default_next_node_id")
                ),
                "error": id_to_name.get(
                    node.get("next_error_node_id"), node.get("next_error_node_id")
                ),
            }
        )

    dt_routing = []
    for node in graph.get("decision_table_node_list", []):
        groups = [
            {
                "group_name": g.get("group_name"),
                "next_node": id_to_name.get(
                    g.get("next_node_id"), g.get("next_node_id")
                ),
            }
            for g in node.get("condition_groups", [])
        ]
        dt_routing.append(
            {
                "node": node.get("node_name"),
                "groups": groups,
                "default": id_to_name.get(
                    node.get("default_next_node_id"), node.get("default_next_node_id")
                ),
                "error": id_to_name.get(
                    node.get("next_error_node_id"), node.get("next_error_node_id")
                ),
            }
        )

    return {
        "edges": edges,
        "conditional_edges": conditional_edges,
        "cdt_routing": cdt_routing,
        "dt_routing": dt_routing,
    }


async def get_cdt_node(graph_id: int, name_or_id: str | int) -> dict[str, Any]:
    """Get full CDT node details: pre/post python code, prompt_configs, condition groups."""
    async with get_client() as client:
        cdt_id, _ = await _get_cdt_node(client, graph_id, name_or_id)
        return await client.get(f"/api/classification-decision-table-node/{cdt_id}/")


async def get_cdt_prompts(graph_id: int, name_or_id: str | int) -> dict[str, Any]:
    """Get the prompt_configs list from a CDT node."""
    async with get_client() as client:
        _, cdt_data = await _get_cdt_node(client, graph_id, name_or_id)
    return {
        "node_name": cdt_data.get("node_name"),
        "prompt_configs": cdt_data.get("prompt_configs", []),
    }


async def get_cdt_route_map(graph_id: int) -> dict[str, Any]:
    """Get routing map for all CDT and DT nodes: which group routes where.

    Each target is reported as both its integer id (how routing actually works)
    and its resolved node NAME (`routing_names`, `default_name`, `error_name`)
    so a human reading the map sees the real wiring — the raw backend response
    leaves the name fields null.
    """
    async with get_client() as client:
        graph = await client.get(f"/api/graphs/{graph_id}/")

    id_to_name = _graph_id_to_name(graph)

    def _name(target_id: Any) -> str | None:
        return id_to_name.get(target_id) if isinstance(target_id, int) else None

    routing: list[dict[str, Any]] = []
    for node_type, list_key in (
        ("cdt", "classification_decision_table_node_list"),
        ("dt", "decision_table_node_list"),
    ):
        for node in graph.get(list_key, []):
            route_map: dict[str, int | None] = {}
            route_names: dict[str, str | None] = {}
            for group in node.get("condition_groups", []):
                group_name = group.get("group_name", "")
                target_id = group.get("next_node_id")
                route_map[group_name] = target_id
                route_names[group_name] = _name(target_id)
            default_id = node.get("default_next_node_id")
            error_id = node.get("next_error_node_id")
            routing.append(
                {
                    "node_type": node_type,
                    "node_name": node.get("node_name"),
                    "node_id": node.get("id"),
                    "routing": route_map,
                    "routing_names": route_names,
                    "default": default_id,
                    "default_name": _name(default_id),
                    "error": error_id,
                    "error_name": _name(error_id),
                }
            )

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
            client,
            graph_id,
            name_or_id,
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
            client,
            graph_id,
            name_or_id,
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
            client,
            graph_id,
            name_or_id,
            [("code_agent_node_list", "code-agent-nodes")],
        )
        payload: dict[str, Any] = {}
        if system_prompt is not None:
            payload["system_prompt"] = system_prompt
        if stream_handler_code is not None or libraries is not None:
            existing_code = node_data.get("python_code") or {}
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
        return await client.patch(
            f"/api/{endpoint}/{node_id}/", json={"metadata": metadata}
        )


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
        return await client.patch(
            f"/api/startnodes/{node_id}/", json={"variables": variables}
        )


async def patch_cdt_node(
    graph_id: int,
    name_or_id: str | int,
    pre_python_code: dict | None = None,
    post_python_code: dict | None = None,
    prompt_configs: list[dict] | None = None,
    condition_groups: list[dict] | None = None,
    default_next_node_id: int | None = None,
    next_error_node_id: int | None = None,
) -> dict[str, Any]:
    """Update CDT node fields. Only provided (non-None) fields are updated.

    pre_python_code / post_python_code are nested code objects
    ({code, entrypoint, libraries}). prompt_configs is a list of
    {prompt_key, prompt_text, llm_config, output_schema, result_variable,
    variable_mappings}. Each condition_group routes via 'next_node_id' (int);
    for pure variable routing set an 'expression' and leave 'prompt_id' unset
    (no LLM call). default_next_node_id / next_error_node_id are node ids for the
    fallback / error branches. Read-only 'id', 'classification_decision_table_node',
    and 'next_node' (name) keys are stripped automatically.

    Rejects, before any network call, a group that sets 'next_node' (a name)
    without an integer 'next_node_id', and a group carrying 'conditions' or
    'group_type' (DT-only fields the CDT model doesn't have) — both crash the
    backend with a 500 if sent as-is.
    """
    if condition_groups is not None:
        _validate_condition_groups(condition_groups, node_kind="cdt")
    async with get_client() as client:
        cdt_id, _ = await _get_cdt_node(client, graph_id, name_or_id)
        payload: dict[str, Any] = {}
        if pre_python_code is not None:
            payload["pre_python_code"] = pre_python_code
        if post_python_code is not None:
            payload["post_python_code"] = post_python_code
        if prompt_configs is not None:
            payload["prompt_configs"] = prompt_configs
        if condition_groups is not None:
            clean_groups = [
                {
                    k: v
                    for k, v in g.items()
                    if k
                    not in ("id", "classification_decision_table_node", "next_node")
                }
                for g in condition_groups
            ]
            payload["condition_groups"] = clean_groups
        if default_next_node_id is not None:
            payload["default_next_node_id"] = default_next_node_id
        if next_error_node_id is not None:
            payload["next_error_node_id"] = next_error_node_id
        return await client.patch(
            f"/api/classification-decision-table-node/{cdt_id}/", json=payload
        )


async def patch_dt_node(
    graph_id: int,
    name_or_id: str | int,
    condition_groups: list[dict],
    default_next_node_id: int | None = None,
    next_error_node_id: int | None = None,
) -> dict[str, Any]:
    """Update Decision Table node condition groups and routing.

    default_next_node_id / next_error_node_id are node ids (ints).
    IMPORTANT: Each condition_group item MUST include 'conditions: []' key —
    the backend calls pop('conditions') and will error if missing.

    Rejects, before any network call, a group that sets 'next_node' (a name)
    without an integer 'next_node_id' — the backend has no 'next_node' field
    and 500s if it reaches it as-is.
    """
    _validate_condition_groups(condition_groups, node_kind="dt")
    async with get_client() as client:
        endpoint, node_id, _ = await _resolve_node(
            client,
            graph_id,
            name_or_id,
            [("decision_table_node_list", "decision-table-node")],
        )
        # Ensure required 'conditions' key and strip the read-only 'next_node' NAME
        # (the read tools emit it; sending it back splats into the model ctor and
        # crashes the DT viewset — routing is via 'next_node_id' only).
        safe_groups = [
            {
                k: v
                for k, v in {**g, "conditions": g.get("conditions", [])}.items()
                if k != "next_node"
            }
            for g in condition_groups
        ]
        payload: dict[str, Any] = {"condition_groups": safe_groups}
        if default_next_node_id is not None:
            payload["default_next_node_id"] = default_next_node_id
        if next_error_node_id is not None:
            payload["next_error_node_id"] = next_error_node_id
        return await client.patch(f"/api/{endpoint}/{node_id}/", json=payload)


async def init_flow_metadata(graph_id: int) -> dict[str, Any]:
    """Initialize UI positions on all nodes in the flow.

    MUST be called after any structural change (add/delete node or edge).
    Sets each node's metadata field with auto-calculated position, color, icon, size.
    """
    # (color, icon, width, height) mirror the frontend's NODE_COLORS / NODE_ICONS
    # (core/enums/node-config.ts) and getDefaultNodeSize (core/helpers/
    # node-size.util.ts), keyed by backend list endpoint, so MCP-styled nodes
    # render identically to ones created by hand in the flow editor.
    _STYLE_MAP: dict[str, tuple[str, str, int, int]] = {
        "startnodes": ("#d3d3d3", "ti ti-player-play-filled", 125, 60),
        "endnodes": ("#d3d3d3", "ti ti-square-rounded", 330, 60),
        "pythonnodes": ("#ffcf3f", "ti ti-brand-python", 330, 60),
        "crewnodes": ("#5672cd", "ti ti-folder", 330, 60),
        "classification-decision-table-node": (
            "#2a5bd7",
            "ti ti-table-options",
            330,
            60,
        ),
        "decision-table-node": ("#00aaff", "ti ti-table", 330, 60),
        "webhook-trigger-nodes": ("#21f367ff", "ti ti-world", 330, 60),
        "telegram-trigger-nodes": ("#229ED9", "ti ti-brand-telegram", 330, 60),
        "schedule-trigger-nodes": ("#FF5C00", "ti ti-calendar", 330, 60),
        "code-agent-nodes": ("#00e676", "ti ti-terminal-2", 330, 60),
        "agentnodes": ("#685fff", "ti ti-robot", 330, 60),
        "tasknodes": ("#2aba6b", "ti ti-circle-check", 330, 60),
    }
    _DEFAULT_STYLE = ("#dddddd", "ti ti-help", 330, 60)

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
                    all_nodes.append(
                        {"id": nid, "name": name, "endpoint": endpoint, "data": node}
                    )

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

        # Assign a monotonic node number to every non start/end node, mirroring
        # the frontend's getNextNodeNumber counter. Any number already present in
        # a node's metadata is preserved so re-running init keeps them stable.
        node_numbers: dict[int, int] = {}
        existing_numbers = [
            (n["data"].get("metadata") or {}).get("nodeNumber") for n in all_nodes
        ]
        next_number = max((v for v in existing_numbers if isinstance(v, int)), default=0) + 1
        for node_info in all_nodes:
            if node_info["endpoint"] in ("startnodes", "endnodes"):
                continue
            existing_num = (node_info["data"].get("metadata") or {}).get("nodeNumber")
            if isinstance(existing_num, int):
                node_numbers[node_info["id"]] = existing_num
            else:
                node_numbers[node_info["id"]] = next_number
                next_number += 1

        # Build PATCH coroutines
        async def _patch_node(node_info: dict[str, Any]) -> dict[str, Any]:
            nid = node_info["id"]
            name = node_info["name"]
            endpoint = node_info["endpoint"]
            color, icon, width, height = _STYLE_MAP.get(endpoint, _DEFAULT_STYLE)
            if endpoint == "decision-table-node":
                # Decision-table height grows with its condition groups; mirror
                # getDecisionTableVisualHeight (core/helpers/node-size.util.ts).
                groups = node_info["data"].get("condition_groups") or []
                valid = sum(1 for g in groups if g.get("valid") is not False)
                height = max(62 + 46 * max(valid + 2, 2), 200)
            x, y = node_positions.get(name, (0, 0))
            metadata: dict[str, Any] = {
                "position": {"x": x, "y": y},
                "color": color,
                "icon": icon,
                "size": {"width": width, "height": height},
            }
            number = node_numbers.get(nid)
            if number is not None:
                metadata["nodeNumber"] = number
            return await client.patch(
                f"/api/{endpoint}/{nid}/", json={"metadata": metadata}
            )

        results = await asyncio.gather(
            *[_patch_node(n) for n in all_nodes], return_exceptions=True
        )

    patched = sum(1 for r in results if not isinstance(r, Exception))
    summary_nodes = []
    for node_info in all_nodes:
        name = node_info["name"]
        x, y = node_positions.get(name, (0, 0))
        summary_nodes.append(
            {"name": name, "type": node_info["endpoint"], "position": {"x": x, "y": y}}
        )

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
        routed = [g for g in groups if g.get("next_node") or g.get("next_node_id")]
        if not routed:
            issues.append(
                f"CDT node '{node.get('node_name')}' has no condition groups with a next_node."
            )

    # DT routing check
    for node in graph.get("decision_table_node_list", []):
        groups = node.get("condition_groups", [])
        routed = [g for g in groups if g.get("next_node") or g.get("next_node_id")]
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


# ---------------------------------------------------------------------------
# validate_flow — deep, read-only structural validation
# ---------------------------------------------------------------------------

# Trigger node list keys have no input port — they are exempt from the
# "must have an incoming edge" check.
_TRIGGER_NODE_LIST_KEYS: tuple[str, ...] = (
    "telegram_trigger_node_list",
    "webhook_trigger_node_list",
    "schedule_trigger_node_list",
)

# All node-bearing list keys inspected for the node inventory (disconnection,
# metadata sync, ports): NODE_LIST_KEYS plus the trigger keys (deduplicated).
_VALIDATION_LIST_KEYS: tuple[str, ...] = tuple(
    {*(key for key, _ in NODE_LIST_KEYS), *_TRIGGER_NODE_LIST_KEYS}
)

# Node list keys whose entries carry a plain `input_map` / `output_variable_path`
# pair (the BaseNode contract). CDT nodes use their own pre_/post_ prefixed
# fields instead and are handled separately.
_IO_NODE_LIST_KEYS: tuple[str, ...] = (
    "crew_node_list",
    "python_node_list",
    "subgraph_node_list",
    "code_agent_node_list",
    "file_extractor_node_list",
    "audio_transcription_node_list",
    "agent_node_list",
    "task_node_list",
)

# Node list keys whose python_code must define an entrypoint function.
_CODE_NODE_LIST_KEYS: tuple[str, ...] = (
    "python_node_list",
    "webhook_trigger_node_list",
)

# A subscript applied directly to `variables` in a CDT expression — the top
# namespace is a SimpleNamespace at runtime, so `variables[...]` raises. Matches
# `variables[` and `variables [` regardless of surrounding tokens.
_VARIABLES_SUBSCRIPT_RE = re.compile(r"\bvariables\s*\[")

_STDLIB_MODULES: frozenset[str] = frozenset(sys.stdlib_module_names) | {"__future__"}

# First-party SDKs the sandbox provides at runtime with no install step —
# not a real "library" the author needs to declare, unlike third-party
# packages. Extend this set as more sandbox-native SDKs ship.
_SANDBOX_NATIVE_MODULES: frozenset[str] = frozenset({"epicstaff_storage"})


def _finding(
    severity: str,
    code: str,
    message: str,
    fix: str,
    node: str | None = None,
) -> dict[str, Any]:
    return {
        "severity": severity,
        "code": code,
        "node": node,
        "message": message,
        "fix": fix,
    }


def _flatten_variable_paths(value: Any, prefix: str) -> set[str]:
    """Flatten a nested dict into every dot-path from `prefix` down to each leaf.

    `{"request": {"city": None}}` under prefix "variables" yields
    {"variables", "variables.request", "variables.request.city"}. Every one of
    these is an *exact*, known-shape declaration — a start variable declares
    precisely this tree, no more.
    """
    paths = {prefix}
    if isinstance(value, dict):
        for key, nested in value.items():
            paths |= _flatten_variable_paths(nested, f"{prefix}.{key}")
    return paths


def _path_satisfied(
    reader_path: str, known_shape_paths: set[str], opaque_write_paths: set[str]
) -> bool:
    """True if `reader_path` resolves against something upstream writes.

    Two distinct sources, matched differently:

    - `known_shape_paths` (start variables) declare an *exact* tree. A reader
      is satisfied only by an exact match, or by asking for the ancestor of a
      more specific declared leaf (`variables.request` is fine when only
      `variables.request.city` was declared — the object exists). It is NOT
      satisfied by asking for an arbitrary *descendant* of a declared path
      (`variables.request.other_field` is NOT covered by declaring
      `variables.request.city` — that field was never actually declared).
      Without this asymmetry, the bare root ("variables") — always present —
      would trivially "cover" every possible reader path.
    - `opaque_write_paths` (a node's `output_variable_path`) is a single
      string whose written *shape* is unknown (the node's return value could
      be any nested dict). Both directions are safe here: a reader below it,
      at it, or above it (an auto-vivified parent namespace) all resolve.
    """
    if reader_path in known_shape_paths:
        return True
    if any(declared.startswith(f"{reader_path}.") for declared in known_shape_paths):
        return True
    return any(
        reader_path == opaque
        or reader_path.startswith(f"{opaque}.")
        or opaque.startswith(f"{reader_path}.")
        for opaque in opaque_write_paths
    )


def _path_unverifiable(reader_path: str, unverifiable_write_paths: set[str]) -> bool:
    """True if `reader_path` is a strict descendant of a root-writer key whose
    nested shape couldn't be pinned down statically (see
    `_infer_root_writer_shape`) — the key itself is proven to exist, but
    what's nested under it is only known at runtime. Such a read is neither
    provably satisfied nor provably broken, so the caller downgrades it to a
    warning instead of asserting a hard `unwritten_input_path` error.
    """
    return any(
        reader_path.startswith(f"{unverifiable}.")
        for unverifiable in unverifiable_write_paths
    )


def _infer_root_writer_shape(
    code: str, entrypoint: str, prefix: str
) -> tuple[set[str], set[str]]:
    """Best-effort static shape inference for a root writer's return value.

    A "root writer" is a node whose output is merged straight into
    `prefix` (bare `"variables"`) — either a python node with
    `output_variable_path: "variables"`, or a webhook/telegram trigger
    handler, whose root write is runtime-forced regardless of what
    `output_variable_path` says (see `_register_writer`). Its return shape
    is a dynamic dict, but the literal keys the code constructs are visible
    to static analysis.

    Parses the top-level `entrypoint` function and inspects every
    `return <dict literal>` statement (all of them — branches in `if`/`try`
    are all considered, since any one of them may fire at runtime). A dict
    key backed by a nested dict *literal* is exact, provable shape — folded
    into `known_shape_paths`, the same semantics as a declared start
    variable (exact-match or ancestor-of-a-declared-leaf reads resolve). A
    key backed by anything else (a name, a call, a comprehension, ...) is
    proven to *exist* but its inner shape is opaque to static analysis —
    folded into `unverifiable_paths`, so reads *of* that key resolve but
    reads *below* it can't be proven either way (`_path_unverifiable`).

    Returns `(known_shape_paths, unverifiable_paths)`, both empty when the
    entrypoint can't be found, the code has a syntax error, or the function
    never returns a dict literal (fully-dynamic output — the caller then has
    no static basis to resolve or downgrade any read against this writer).
    """
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return set(), set()

    function_node = next(
        (
            stmt
            for stmt in tree.body
            if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef))
            and stmt.name == entrypoint
        ),
        None,
    )
    if function_node is None:
        return set(), set()

    known_shape_paths: set[str] = set()
    unverifiable_paths: set[str] = set()

    def _walk_dict_literal(dict_node: ast.Dict, path: str) -> None:
        known_shape_paths.add(path)
        for key_node, value_node in zip(dict_node.keys, dict_node.values):
            if not isinstance(key_node, ast.Constant) or not isinstance(
                key_node.value, str
            ):
                continue  # dynamic (**-splatted or computed) key — no static path
            key_path = f"{path}.{key_node.value}"
            if isinstance(value_node, ast.Dict):
                _walk_dict_literal(value_node, key_path)
            else:
                unverifiable_paths.add(key_path)

    for stmt in ast.walk(function_node):
        if isinstance(stmt, ast.Return) and isinstance(stmt.value, ast.Dict):
            _walk_dict_literal(stmt.value, prefix)

    return known_shape_paths, unverifiable_paths


def _extract_conditional_edge_target_ids(code: str) -> set[int]:
    """Best-effort extraction of node ids a conditional edge's code may route to.

    The documented convention (see `add_conditional_edge`) is that the code
    returns a string shaped `"<node_name> #<id>"`. This scans every string
    constant in the code for that `#<id>` suffix. It is a static
    approximation used only to extend forward-reachability for the
    duplicate-writer branch check below — never for correctness-critical
    routing (the runtime routes on the returned string, not this).
    """
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return set()
    target_ids: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            target_ids.update(int(match) for match in re.findall(r"#(\d+)", node.value))
    return target_ids


def _build_forward_adjacency(graph: dict[str, Any]) -> dict[int, set[int]]:
    """Build a node-id -> reachable-successor-ids adjacency map for the
    whole graph: regular edges, CDT/DT branch targets (each condition
    group's `next_node_id`, `default_next_node_id`, `next_error_node_id`),
    and conditional-edge targets (regex-extracted from the routing code).
    Used only for forward-reachability queries, not for the branch-pairing
    itself — see `_writers_share_exclusive_cdt_branch`.
    """
    adjacency: dict[int, set[int]] = {}

    def _connect(source: Any, target: Any) -> None:
        if isinstance(source, int) and isinstance(target, int):
            adjacency.setdefault(source, set()).add(target)

    for edge in graph.get("edge_list", []):
        _connect(edge.get("start_node_id"), edge.get("end_node_id"))

    for node in (
        *graph.get("classification_decision_table_node_list", []),
        *graph.get("decision_table_node_list", []),
    ):
        source = node.get("id")
        _connect(source, node.get("default_next_node_id"))
        _connect(source, node.get("next_error_node_id"))
        for group in node.get("condition_groups", []):
            _connect(source, group.get("next_node_id"))

    for edge in graph.get("conditional_edge_list", []):
        source = edge.get("source_node_id")
        code = (edge.get("python_code") or {}).get("code") or ""
        for target_id in _extract_conditional_edge_target_ids(code):
            _connect(source, target_id)

    return adjacency


def _reachable_from(start: int, adjacency: dict[int, set[int]]) -> set[int]:
    """Forward BFS/DFS reachable set from `start` (inclusive of `start`)."""
    visited: set[int] = set()
    stack = [start]
    while stack:
        current = stack.pop()
        if current in visited:
            continue
        visited.add(current)
        stack.extend(adjacency.get(current, ()))
    return visited


def _cdt_dt_branch_targets(node: dict[str, Any]) -> list[tuple[str, int]]:
    """Distinct (branch_label, target_node_id) exits for one CDT/DT node —
    each condition group plus the default and error routes."""
    branches: list[tuple[str, int]] = []
    for group in node.get("condition_groups", []):
        target = group.get("next_node_id")
        if isinstance(target, int):
            branches.append((f"group:{group.get('group_name')}", target))
    for label, key in (("default", "default_next_node_id"), ("error", "next_error_node_id")):
        target = node.get(key)
        if isinstance(target, int):
            branches.append((label, target))
    return branches


def _writers_share_exclusive_cdt_branch(
    writer_a_id: int,
    writer_b_id: int,
    graph: dict[str, Any],
    adjacency: dict[int, set[int]],
) -> bool:
    """True if `writer_a_id` and `writer_b_id` are each reachable from a
    *different* condition-group/default/error branch of the same CDT/DT
    node — the standard "route A writes X, route B writes X" convergence
    pattern (exactly one route fires per run), not an override-last-wins
    bug.

    This is a structural heuristic, not a full path-exclusivity proof: it
    only asks "is A reachable from branch 1, and B reachable from a
    different branch 2 of the same node?" — it does not additionally
    require that A be *unreachable* from branch 2 (or vice versa). A writer
    reachable from every branch of a router still counts as living on "a"
    branch. Two writers with no common CDT/DT ancestor at all (pure
    sequential edges, e.g. node A directly feeding node B) are never
    considered exclusive by this check and still get flagged.
    """
    for node in (
        *graph.get("classification_decision_table_node_list", []),
        *graph.get("decision_table_node_list", []),
    ):
        branches = _cdt_dt_branch_targets(node)
        if len(branches) < 2:
            continue
        reach_by_label = {
            label: _reachable_from(target, adjacency) for label, target in branches
        }
        for (label_a, reach_a), (label_b, reach_b) in itertools.permutations(
            reach_by_label.items(), 2
        ):
            if label_a == label_b:
                continue
            if writer_a_id in reach_a and writer_b_id in reach_b:
                return True
    return False


def _extract_top_level_imports(code: str) -> set[str]:
    """Return the root module names imported by `code` (skips relative imports)."""
    tree = ast.parse(code)
    modules: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                modules.add(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            if node.level == 0 and node.module:
                modules.add(node.module.split(".")[0])
    return modules


def _defines_entrypoint(code: str, entrypoint: str) -> bool:
    """True if `code` defines a top-level (sync or async) function named `entrypoint`."""
    tree = ast.parse(code)
    return any(
        isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef))
        and stmt.name == entrypoint
        for stmt in tree.body
    )


# ---------------------------------------------------------------------------
# Return-shape inference and safe CDT/DT expression dry-run evaluation
# ---------------------------------------------------------------------------


class _UnknownValue:
    """Sentinel for a runtime value whose shape static analysis can't pin down.

    Populates the dry-run namespace at paths written by a node whose return
    isn't a provable literal. It never raises on the reads a CDT expression
    performs (attribute, item, comparison), so an unprovable path can never
    produce a false `cdt_expression_error`; it also never compares equal to
    anything, so it can't make a comparison spuriously pass.
    """

    def __getattr__(self, _name: str) -> "_UnknownValue":
        return self

    def __getitem__(self, _key: Any) -> "_UnknownValue":
        return self

    def __eq__(self, _other: Any) -> bool:
        return False

    def __ne__(self, _other: Any) -> bool:
        return False

    def __lt__(self, _other: Any) -> bool:
        return False

    def __le__(self, _other: Any) -> bool:
        return False

    def __gt__(self, _other: Any) -> bool:
        return False

    def __ge__(self, _other: Any) -> bool:
        return False

    def __bool__(self) -> bool:
        return False

    def __hash__(self) -> int:
        return 0


_UNKNOWN = _UnknownValue()


class _SampleNamespace(SimpleNamespace):
    """A dot-accessible sample of the `variables` namespace for dry-run eval.

    Supports item access too (`variables.raw['temp']`), delegating to the
    attribute of the same name — a missing key raises (KeyError/AttributeError)
    so a typo'd or unwritten path surfaces as a `cdt_expression_error` rather
    than silently passing. Top-level `variables[...]` subscripting is caught
    separately by the regex check; this class deliberately mirrors runtime
    dot-navigation for everything that is legitimately reachable.
    """

    def __getitem__(self, key: Any) -> Any:
        try:
            return getattr(self, key)
        except (AttributeError, TypeError) as exc:
            raise KeyError(key) from exc


def _entrypoint_function(
    code: str, entrypoint: str
) -> ast.FunctionDef | ast.AsyncFunctionDef | None:
    """Parse `code` and return the top-level `entrypoint` function, or None."""
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return None
    return next(
        (
            stmt
            for stmt in tree.body
            if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef))
            and stmt.name == entrypoint
        ),
        None,
    )


def _iter_returns(func: ast.AST) -> list[ast.Return]:
    """Every `return` statement lexically inside `func` but NOT inside a nested
    function/lambda (those returns belong to a different call frame)."""
    returns: list[ast.Return] = []
    stack = list(ast.iter_child_nodes(func))
    while stack:
        node = stack.pop()
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            continue
        if isinstance(node, ast.Return):
            returns.append(node)
        stack.extend(ast.iter_child_nodes(node))
    return returns


def _classify_value_node(node: ast.AST) -> str:
    """Category of a value AST node: 'dict', 'list', 'scalar', or 'unknown'."""
    if isinstance(node, ast.Dict):
        return "dict"
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        return "list"
    if isinstance(node, ast.JoinedStr):  # f-string is always a str
        return "scalar"
    if isinstance(node, ast.Constant):
        if isinstance(node.value, (str, int, float, bool)):
            return "scalar"
        return "unknown"  # None, bytes, ...
    return "unknown"


def _value_categories(node: ast.AST) -> set[str]:
    """Categories a value expression can take, expanding IfExp branches."""
    if isinstance(node, ast.IfExp):
        return _value_categories(node.body) | _value_categories(node.orelse)
    return {_classify_value_node(node)}


def _entrypoint_return_shapes(code: str, entrypoint: str) -> set[str]:
    """Union of value categories across every `return` in the entrypoint.

    Empty set means no return / entrypoint not found / syntax error — the
    writer's shape is then unknown and no shape finding should be emitted.
    """
    func = _entrypoint_function(code, entrypoint)
    if func is None:
        return set()
    shapes: set[str] = set()
    for stmt in _iter_returns(func):
        if stmt.value is not None:
            shapes |= _value_categories(stmt.value)
    return shapes


def _literal_to_sample(node: ast.AST) -> Any:
    """Best-effort concrete Python sample of a literal AST value node.

    Dict/list literals are reconstructed (recursively); scalar constants and
    f-strings become a representative value of the right type; anything else
    (a name, a call, ...) becomes `_UNKNOWN`.
    """
    if isinstance(node, ast.Dict):
        sample: dict[str, Any] = {}
        for key_node, value_node in zip(node.keys, node.values):
            if isinstance(key_node, ast.Constant) and isinstance(key_node.value, str):
                sample[key_node.value] = _literal_to_sample(value_node)
        return sample
    if isinstance(node, ast.JoinedStr):
        return ""
    if isinstance(node, ast.Constant):
        return (
            node.value if isinstance(node.value, (str, int, float, bool)) else _UNKNOWN
        )
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        return [_literal_to_sample(element) for element in node.elts]
    if isinstance(node, ast.IfExp):
        return _literal_to_sample(node.body)
    return _UNKNOWN


def _entrypoint_return_sample(code: str, entrypoint: str) -> Any:
    """A representative value the entrypoint returns (first return), or `_UNKNOWN`."""
    func = _entrypoint_function(code, entrypoint)
    if func is None:
        return _UNKNOWN
    for stmt in _iter_returns(func):
        if stmt.value is not None:
            return _literal_to_sample(stmt.value)
    return _UNKNOWN


def _deep_merge_sample(target: dict[str, Any], source: dict[str, Any]) -> None:
    """Recursively merge `source` into `target`, copying nested containers."""
    for key, value in source.items():
        if not isinstance(key, str):
            continue
        if isinstance(value, dict) and isinstance(target.get(key), dict):
            _deep_merge_sample(target[key], value)
        elif isinstance(value, (dict, list)):
            target[key] = deepcopy(value)
        else:
            target[key] = value


def _set_sample_path(root: dict[str, Any], dotted: str, value: Any) -> None:
    """Set a `variables.<a>.<b>` path in the sample dict, creating parents."""
    parts = dotted.split(".")
    if len(parts) < 2:
        return
    current = root
    for segment in parts[1:-1]:
        nxt = current.get(segment)
        if not isinstance(nxt, dict):
            nxt = {}
            current[segment] = nxt
        current = nxt
    current[parts[-1]] = value


def _to_sample_namespace(value: Any) -> Any:
    """Recursively turn a sample dict into a dot-accessible `_SampleNamespace`."""
    if isinstance(value, dict):
        return _SampleNamespace(
            **{
                key: _to_sample_namespace(nested)
                for key, nested in value.items()
                if isinstance(key, str)
            }
        )
    if isinstance(value, list):
        return [_to_sample_namespace(element) for element in value]
    return value


def _unwrap_start_variables(node: dict[str, Any]) -> dict[str, Any]:
    """A start node's flat `variables` namespace, unwrapping the persistence
    wire format if present.

    When a flow opts into cross-session persistence, the backend stores the
    start node's `variables` wrapped as
    ``{"variables": {<real namespace>}, "persistent_variables": {...}}``. Every
    reader still addresses the *inner* namespace (`variables.context.foo`), so
    validation must look through that wrapper — otherwise a declared path reads
    as unwritten. The compiler's validation graph keeps the flat shape, so a
    non-persistence graph passes straight through unchanged.
    """
    variables = node.get("variables")
    if not isinstance(variables, dict):
        return {}
    if (
        isinstance(variables.get("variables"), dict)
        and "persistent_variables" in variables
    ):
        return variables["variables"]
    return variables


def _build_dryrun_namespace(graph: dict[str, Any]) -> _SampleNamespace:
    """Assemble a sandboxed `variables` sample from declared start variables plus
    every statically-inferable writer output. Never mutates `graph`."""
    base: dict[str, Any] = {}
    for node in graph.get("start_node_list", []):
        _deep_merge_sample(base, _unwrap_start_variables(node))

    for node in graph.get("python_node_list", []):
        path = node.get("output_variable_path")
        python_code = node.get("python_code") or {}
        sample = _entrypoint_return_sample(
            python_code.get("code") or "", python_code.get("entrypoint") or "main"
        )
        if path == "variables":
            if isinstance(sample, dict):
                _deep_merge_sample(base, sample)
        elif isinstance(path, str) and path.startswith("variables."):
            _set_sample_path(base, path, sample)

    # Platform-injected namespaces certain node types guarantee at runtime.
    if graph.get("telegram_trigger_node_list"):
        base.setdefault("telegram_payload", _UNKNOWN)
    if graph.get("file_extractor_node_list") or graph.get(
        "audio_transcription_node_list"
    ):
        base.setdefault("files", _UNKNOWN)

    return _to_sample_namespace(base)


def _attr_chain(node: ast.AST) -> str | None:
    """Dotted path of a `variables`-rooted attribute chain, or None.

    `variables.weather.raw` -> "variables.weather.raw"; anything not rooted at
    the `variables` name (a call, a subscript, another name) -> None.
    """
    if isinstance(node, ast.Name):
        return node.id if node.id == "variables" else None
    if isinstance(node, ast.Attribute):
        base = _attr_chain(node.value)
        return f"{base}.{node.attr}" if base is not None else None
    return None


def _const_kind(node: ast.AST) -> str | None:
    """'scalar'/'dict'/'list' for a constant/container literal node, else None."""
    if isinstance(node, ast.JoinedStr):
        return "scalar"
    if isinstance(node, ast.Constant) and isinstance(
        node.value, (str, int, float, bool)
    ):
        return "scalar"
    if isinstance(node, ast.Dict):
        return "dict"
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        return "list"
    return None


def _expression_path_signals(expression: str) -> tuple[list[tuple[str, str]], set[str]]:
    """Static read-signals of a CDT/DT expression.

    Returns `(comparisons, read_paths)` where `comparisons` are
    `(variables_path, compared_const_kind)` pairs for every `path <op> literal`
    (or reversed) comparison, and `read_paths` is the set of maximal
    `variables`-rooted attribute chains the expression reads.
    """
    try:
        tree = ast.parse(expression, mode="eval")
    except SyntaxError:
        return [], set()

    comparisons: list[tuple[str, str]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Compare) and len(node.comparators) == 1:
            left, right = node.left, node.comparators[0]
            left_path, right_path = _attr_chain(left), _attr_chain(right)
            left_kind, right_kind = _const_kind(left), _const_kind(right)
            if left_path and left_path != "variables" and right_kind:
                comparisons.append((left_path, right_kind))
            elif right_path and right_path != "variables" and left_kind:
                comparisons.append((right_path, left_kind))

    chains: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Attribute, ast.Name)):
            chain = _attr_chain(node)
            if chain and chain != "variables":
                chains.add(chain)
    maximal = {
        chain
        for chain in chains
        if not any(other != chain and other.startswith(f"{chain}.") for other in chains)
    }
    return comparisons, maximal


def _expression_safety(tree: ast.AST) -> str:
    """Classify an expression AST for safe dry-run: 'unsafe', 'call', or 'safe'.

    'unsafe' — reaches a dunder name/attribute (the classic sandbox-escape
    primitive); refuse to evaluate. 'call' — contains a function call; we
    cannot vouch for it under an empty-builtins eval, so skip evaluation. 'safe'
    — a plain expression over `variables` (names, attributes, subscripts,
    operators, literals) that cannot execute arbitrary code with no builtins.
    """
    has_call = False
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute) and node.attr.startswith("__"):
            return "unsafe"
        if isinstance(node, ast.Name) and node.id.startswith("__"):
            return "unsafe"
        if isinstance(node, ast.Call):
            has_call = True
    return "call" if has_call else "safe"


_SAMPLE_CONTAINER_TYPES = (dict, list, tuple, set, SimpleNamespace)


def _types_never_equal(left: Any, right: Any) -> bool:
    """True if `left == right` can never hold given the operand types alone.

    A container compared to a scalar, or a string compared to a number, is
    always unequal regardless of value. `_UNKNOWN` operands are never judged.
    """
    if isinstance(left, _UnknownValue) or isinstance(right, _UnknownValue):
        return False
    left_container = isinstance(left, _SAMPLE_CONTAINER_TYPES)
    right_container = isinstance(right, _SAMPLE_CONTAINER_TYPES)
    if left_container != right_container:
        return True
    left_str, right_str = isinstance(left, str), isinstance(right, str)
    left_num = isinstance(left, (int, float)) and not isinstance(left, bool)
    right_num = isinstance(right, (int, float)) and not isinstance(right, bool)
    return (left_str and right_num) or (left_num and right_str)


def _safe_eval(node: ast.AST, namespace: _SampleNamespace) -> Any:
    """Evaluate an already-safety-checked AST node against the sample namespace,
    with no builtins. Raises on any evaluation error — callers catch it."""
    expression = ast.Expression(node) if not isinstance(node, ast.Expression) else node
    ast.fix_missing_locations(expression)
    compiled = compile(expression, "<cdt-expression>", "eval")
    return eval(compiled, {"__builtins__": {}}, {"variables": namespace})


def _evaluate_cdt_expression(
    node_name: str, group_name: str, expression: str, namespace: _SampleNamespace
) -> list[dict[str, Any]]:
    """Safe dry-run of one CDT/DT group expression against the sample namespace.

    Emits: `cdt_expression_error` (error) for a syntax error, a dunder-access
    escape attempt, or an expression that raises against the sample (typo'd or
    wrong-shape path); `cdt_expression_uncheckable` (warning) for an expression
    with a function call we won't evaluate; `cdt_expression_not_boolean`
    (warning) for a non-boolean result; `cdt_expression_never_true` (warning)
    for a type-incompatible equality that can never hold.
    """
    try:
        tree = ast.parse(expression, mode="eval")
    except SyntaxError as exc:
        return [
            _finding(
                "error",
                "cdt_expression_error",
                f"CDT/DT node '{node_name}' group '{group_name}' expression has a "
                f"syntax error: {exc}.",
                "Fix the expression — it must be a Python boolean over `variables` "
                "using dot notation (e.g. variables.route == 'x').",
                node=node_name,
            )
        ]

    safety = _expression_safety(tree)
    if safety == "unsafe":
        return [
            _finding(
                "error",
                "cdt_expression_error",
                f"CDT/DT node '{node_name}' group '{group_name}' expression uses "
                f"dunder/introspection access ({expression!r}), which is not "
                "permitted.",
                "Use a plain boolean over `variables` (e.g. variables.route == 'x') "
                "— no dunder attributes or object introspection.",
                node=node_name,
            )
        ]
    if safety == "call":
        return [
            _finding(
                "warning",
                "cdt_expression_uncheckable",
                f"CDT/DT node '{node_name}' group '{group_name}' expression contains "
                f"a function call ({expression!r}); it was skipped by the offline "
                "dry-run evaluator.",
                "Keep CDT/DT expressions to plain comparisons over `variables` so "
                "they validate offline, or verify this one at runtime.",
                node=node_name,
            )
        ]

    try:
        result = _safe_eval(tree.body, namespace)
    except Exception as exc:  # noqa: BLE001 — surface every failure as a finding
        return [
            _finding(
                "error",
                "cdt_expression_error",
                f"CDT/DT node '{node_name}' group '{group_name}' expression "
                f"{expression!r} raises when evaluated against the flow's declared "
                f"variables: {type(exc).__name__}: {exc}.",
                "The path is likely misspelled, unwritten, or the wrong shape — it "
                "dead-ends the branch at runtime. Declare/write the path or fix the "
                "expression.",
                node=node_name,
            )
        ]

    findings: list[dict[str, Any]] = []
    if not isinstance(result, bool) and not isinstance(result, _UnknownValue):
        findings.append(
            _finding(
                "warning",
                "cdt_expression_not_boolean",
                f"CDT/DT node '{node_name}' group '{group_name}' expression "
                f"{expression!r} evaluates to a non-boolean "
                f"({type(result).__name__}).",
                "A group expression should be a boolean — restructure it to a "
                "comparison that yields True/False.",
                node=node_name,
            )
        )

    body = tree.body
    if (
        isinstance(body, ast.Compare)
        and len(body.ops) == 1
        and isinstance(body.ops[0], ast.Eq)
        and result is False
    ):
        try:
            left_value = _safe_eval(body.left, namespace)
            right_value = _safe_eval(body.comparators[0], namespace)
        except Exception:  # noqa: BLE001 — the whole-expression eval already succeeded
            left_value = right_value = None
        else:
            if _types_never_equal(left_value, right_value):
                findings.append(
                    _finding(
                        "warning",
                        "cdt_expression_never_true",
                        f"CDT/DT node '{node_name}' group '{group_name}' expression "
                        f"{expression!r} compares values of incompatible types "
                        f"({type(left_value).__name__} == "
                        f"{type(right_value).__name__}); it can never be true.",
                        "Compare the path to a value of the same type, or fix the "
                        "upstream writer's return shape.",
                        node=node_name,
                    )
                )
    return findings


def _validate_graph(graph: dict[str, Any]) -> list[dict[str, Any]]:
    """Deep, read-only structural validation of an already-fetched flow graph.

    Pure function over a flow graph dict shaped like the `/api/graphs/{id}/`
    response (the same shape `save_flow` sends and `export_flow` returns) — no
    network I/O, no mutation. This is the single source of truth for flow
    structural checks; `validate_flow` and the offline eval harness both call
    it against a graph dict, fetched live or loaded from a fixture.

    Beyond test_flow's shallow checks (start/end presence, edge connectivity,
    CDT/DT has a next_node, python code non-empty), this also validates:
    input_map/output_variable_path continuity (undeclared reads, dangling end
    node output_map targets), CDT/DT routing by integer id vs stray node name,
    dangling routing targets, `def <entrypoint>` presence in python/webhook
    code, missing `libraries` for non-stdlib imports, `ports: []` (must be
    null), and per-node metadata sync (the "black dots" symptom).

    Returns a list of findings: [{"severity", "code", "node", "message", "fix"}].
    """
    graph_id = graph.get("id")
    findings: list[dict[str, Any]] = []

    # -- Node inventory -----------------------------------------------------
    id_to_name: dict[int, str] = {}
    all_node_ids: set[int] = set()
    for list_key in _VALIDATION_LIST_KEYS:
        for node in graph.get(list_key, []):
            nid = node.get("id")
            if nid is None:
                continue
            all_node_ids.add(nid)
            id_to_name[nid] = node.get("node_name") or node.get("name", str(nid))

    # -- Start / end presence ------------------------------------------------
    start_nodes = graph.get("start_node_list", [])
    if not start_nodes:
        findings.append(
            _finding(
                "error",
                "missing_start_node",
                "Flow has no start node.",
                "Add a startnode via add_node so the session has an entry point.",
            )
        )

    end_nodes = graph.get("end_node_list", [])
    if not end_nodes:
        findings.append(
            _finding(
                "error",
                "missing_end_node",
                "Flow has no end node.",
                "Add an endnode via add_node so the session has a terminal projection.",
            )
        )

    # -- Connectivity ---------------------------------------------------------
    connected_ids: set[int] = set()
    for e in graph.get("edge_list", []):
        if e.get("start_node_id") is not None:
            connected_ids.add(e["start_node_id"])
        if e.get("end_node_id") is not None:
            connected_ids.add(e["end_node_id"])
    for e in graph.get("conditional_edge_list", []):
        if e.get("source_node_id") is not None:
            connected_ids.add(e["source_node_id"])

    trigger_ids: set[int] = set()
    for list_key in _TRIGGER_NODE_LIST_KEYS:
        for n in graph.get(list_key, []):
            if n.get("id") is not None:
                trigger_ids.add(n["id"])

    cdt_nodes = graph.get("classification_decision_table_node_list", [])
    dt_nodes = graph.get("decision_table_node_list", [])
    cdt_dt_ids: set[int] = {
        n["id"] for n in (*cdt_nodes, *dt_nodes) if n.get("id") is not None
    }

    # CDT/DT route targets receive an incoming connection even though it is
    # metadata-based, not an edge_list entry.
    for node in (*cdt_nodes, *dt_nodes):
        for key in ("default_next_node_id", "next_error_node_id"):
            target = node.get(key)
            if isinstance(target, int):
                connected_ids.add(target)
        for group in node.get("condition_groups", []):
            target = group.get("next_node_id")
            if isinstance(target, int):
                connected_ids.add(target)

    # CDT/DT nodes route via metadata, not edge_list — same exemption as
    # trigger nodes (test_flow only exempted DT; CDT has the identical gap).
    exempt_ids = trigger_ids | cdt_dt_ids
    for nid in sorted(all_node_ids - exempt_ids - connected_ids):
        findings.append(
            _finding(
                "error",
                "disconnected_node",
                f"Node '{id_to_name.get(nid, nid)}' (id={nid}) has no incoming or "
                "outgoing edge and is not a trigger or CDT/DT routing target.",
                "Wire it with add_edge, or route to/from it via patch_cdt_node/"
                "patch_dt_node if it is meant to be reached through routing metadata.",
                node=id_to_name.get(nid, str(nid)),
            )
        )

    # -- CDT / DT routing correctness ----------------------------------------
    def _check_routing_target(
        node_name: str, label: str, target_id: Any, target_name: Any
    ) -> None:
        if target_id is None:
            if target_name:
                findings.append(
                    _finding(
                        "error",
                        "cdt_route_by_name",
                        f"CDT/DT node '{node_name}' routes '{label}' by name "
                        f"('{target_name}') instead of an integer next_node_id.",
                        "Routing is metadata-based on integer node ids — resolve the "
                        "target's numeric id and set it via patch_cdt_node/patch_dt_node "
                        "(a name causes a 500 / server disconnect at runtime).",
                        node=node_name,
                    )
                )
            return
        if not isinstance(target_id, int) or target_id not in all_node_ids:
            findings.append(
                _finding(
                    "error",
                    "cdt_dangling_route",
                    f"CDT/DT node '{node_name}' routes '{label}' to node id "
                    f"{target_id!r}, which does not exist in this flow.",
                    "Set the target to a real node id (patch_cdt_node/patch_dt_node), "
                    "or remove the stale routing.",
                    node=node_name,
                )
            )

    for node in (*cdt_nodes, *dt_nodes):
        node_name = node.get("node_name") or str(node.get("id"))
        groups = node.get("condition_groups", [])
        if not groups:
            findings.append(
                _finding(
                    "error",
                    "cdt_no_routing",
                    f"CDT/DT node '{node_name}' has no condition groups.",
                    "Add at least one condition group with a next_node_id via "
                    "patch_cdt_node/patch_dt_node.",
                    node=node_name,
                )
            )
        for group in groups:
            group_label = f"group '{group.get('group_name', '?')}'"
            _check_routing_target(
                node_name,
                group_label,
                group.get("next_node_id"),
                group.get("next_node"),
            )

        default_next_node_id = node.get("default_next_node_id")
        if default_next_node_id is None:
            findings.append(
                _finding(
                    "warning",
                    "cdt_no_default_route",
                    f"CDT/DT node '{node_name}' has no default_next_node_id.",
                    "Set default_next_node_id so an unmatched input doesn't dead-end.",
                    node=node_name,
                )
            )
        else:
            _check_routing_target(
                node_name, "default_next_node_id", default_next_node_id, None
            )

        next_error_node_id = node.get("next_error_node_id")
        if next_error_node_id is None:
            findings.append(
                _finding(
                    "warning",
                    "cdt_no_error_route",
                    f"CDT/DT node '{node_name}' has no next_error_node_id.",
                    "Set next_error_node_id so an evaluation error routes somewhere "
                    "instead of silently falling back to END.",
                    node=node_name,
                )
            )
        else:
            _check_routing_target(
                node_name, "next_error_node_id", next_error_node_id, None
            )

    # -- CDT-specific: expression syntax and connector rendering --------------
    # `variables` is exposed to a CDT group expression as an attribute object
    # (SimpleNamespace), not a dict. A subscript on it (variables['x']) raises
    # "'types.SimpleNamespace' object is not subscriptable" at runtime, which
    # the CDT swallows into its error branch — the flow silently routes to the
    # error node (or END) and the intended branch never fires. `route_code`
    # drives the branch connector the editor draws; a null one routes correctly
    # but renders no line ("invisible branch").
    for node in cdt_nodes:
        node_name = node.get("node_name") or str(node.get("id"))
        for group in node.get("condition_groups", []):
            group_name = group.get("group_name", "?")
            expression = group.get("expression")
            if expression and _VARIABLES_SUBSCRIPT_RE.search(expression):
                findings.append(
                    _finding(
                        "error",
                        "cdt_expression_subscript",
                        f"CDT node '{node_name}' group '{group_name}' expression "
                        f"subscripts `variables` ({expression!r}).",
                        "`variables` is a SimpleNamespace at runtime — use dot "
                        "notation (variables.route == 'x'), not variables['route']. "
                        "The subscript raises at runtime and dead-ends the branch.",
                        node=node_name,
                    )
                )
            if not group.get("route_code"):
                findings.append(
                    _finding(
                        "warning",
                        "cdt_missing_route_code",
                        f"CDT node '{node_name}' group '{group_name}' has no "
                        "route_code.",
                        "Set a unique non-null route_code (default it to the "
                        "group_name) — without it the branch routes at runtime but "
                        "draws no connector on the canvas.",
                        node=node_name,
                    )
                )

    # -- CDT/DT expression shape mismatch + safe dry-run ----------------------
    # The silent-misroute trap: a python node returning a dict literal into a
    # scalar-shaped output_variable_path (e.g. `return {"route": "x"}` into
    # `variables.route`) makes that path a DICT, so a CDT expression comparing
    # it to a scalar (`variables.route == 'x'`) never matches — no error, wrong
    # branch. We link each python writer's statically-known return shape to the
    # path it writes and cross-check every CDT/DT expression that reads it, then
    # dry-run-evaluate each expression against a sandboxed sample namespace to
    # catch typo'd/missing paths, non-boolean predicates, and impossible
    # comparisons that today route to error/default with no finding.
    python_writer_shapes: dict[str, set[str]] = {}
    python_writer_names: dict[str, str] = {}
    for node in graph.get("python_node_list", []):
        path = node.get("output_variable_path")
        if not (isinstance(path, str) and path.startswith("variables.")):
            continue
        python_code = node.get("python_code") or {}
        shapes = _entrypoint_return_shapes(
            python_code.get("code") or "", python_code.get("entrypoint") or "main"
        )
        if shapes:
            python_writer_shapes[path] = shapes
            python_writer_names[path] = node.get("node_name") or str(node.get("id"))

    dryrun_namespace = _build_dryrun_namespace(graph)

    for node in (*cdt_nodes, *dt_nodes):
        node_name = node.get("node_name") or str(node.get("id"))
        for group in node.get("condition_groups", []):
            group_name = group.get("group_name", "?")
            expression = group.get("expression")
            if not expression:
                continue

            comparisons, read_paths = _expression_path_signals(expression)
            for compare_path, compare_kind in comparisons:
                if compare_kind != "scalar":
                    continue
                shapes = python_writer_shapes.get(compare_path)
                if not shapes:
                    continue
                writer = python_writer_names[compare_path]
                container_shapes = shapes & {"dict", "list"}
                if not container_shapes:
                    continue
                shape_label = " and ".join(sorted(container_shapes))
                if shapes <= {"dict", "list"}:
                    findings.append(
                        _finding(
                            "error",
                            "output_shape_mismatch",
                            f"CDT/DT node '{node_name}' group '{group_name}' compares "
                            f"'{compare_path}' to a scalar, but python node "
                            f"'{writer}' writes a {shape_label} to that path (its "
                            "return is a container literal). The comparison can never "
                            "match — the branch silently never fires.",
                            f"Return the scalar directly from '{writer}' (return the "
                            "value, not a container), or set its output_variable_path "
                            f"to the parent and compare the nested key "
                            f"(e.g. {compare_path}.<key>).",
                            node=node_name,
                        )
                    )
                elif "unknown" not in shapes:
                    findings.append(
                        _finding(
                            "warning",
                            "output_shape_mismatch",
                            f"CDT/DT node '{node_name}' group '{group_name}' compares "
                            f"'{compare_path}' to a scalar, but python node "
                            f"'{writer}' sometimes writes a {shape_label} there (its "
                            f"return shape varies: {sorted(shapes)}). The comparison "
                            "won't match on the container branch.",
                            f"Make '{writer}' return a consistent scalar for "
                            f"'{compare_path}', or compare the nested key.",
                            node=node_name,
                        )
                    )

            for read_path in read_paths:
                for writer_path, shapes in python_writer_shapes.items():
                    if read_path.startswith(f"{writer_path}.") and shapes <= {"scalar"}:
                        member = read_path[len(writer_path) + 1 :]
                        findings.append(
                            _finding(
                                "error",
                                "output_shape_mismatch",
                                f"CDT/DT node '{node_name}' group '{group_name}' reads "
                                f"'{read_path}', but python node "
                                f"'{python_writer_names[writer_path]}' writes a scalar "
                                f"to '{writer_path}' — a scalar has no '{member}' "
                                "member, so this raises at runtime and dead-ends the "
                                "branch.",
                                f"Have '{python_writer_names[writer_path]}' return a "
                                f"dict shaped for the read, or compare "
                                f"'{writer_path}' directly.",
                                node=node_name,
                            )
                        )
                        break

            findings.extend(
                _evaluate_cdt_expression(
                    node_name, group_name, expression, dryrun_namespace
                )
            )

    # -- python / webhook code correctness ------------------------------------
    for list_key in _CODE_NODE_LIST_KEYS:
        for node in graph.get(list_key, []):
            node_name = node.get("node_name") or str(node.get("id"))
            python_code = node.get("python_code") or {}
            code = python_code.get("code", "")
            if not code or not code.strip():
                findings.append(
                    _finding(
                        "error",
                        "empty_code",
                        f"Node '{node_name}' has empty python_code.code.",
                        "Add an implementation via patch_python_node/patch_webhook_node.",
                        node=node_name,
                    )
                )
                continue

            entrypoint = python_code.get("entrypoint") or "main"
            try:
                tree_imports = _extract_top_level_imports(code)
                has_entrypoint = _defines_entrypoint(code, entrypoint)
            except SyntaxError as exc:
                findings.append(
                    _finding(
                        "error",
                        "python_syntax_error",
                        f"Node '{node_name}' python_code has a syntax error: {exc}",
                        "Fix the code — it cannot execute in the sandbox as written.",
                        node=node_name,
                    )
                )
                continue

            if not has_entrypoint:
                findings.append(
                    _finding(
                        "error",
                        "missing_entrypoint",
                        f"Node '{node_name}' python_code has no top-level "
                        f"`def {entrypoint}(...)`.",
                        f"Define `def {entrypoint}(...)` — the executor calls it by name "
                        f"and fails with \"name '{entrypoint}' is not defined\" otherwise.",
                        node=node_name,
                    )
                )

            libraries = set(python_code.get("libraries") or [])
            missing = sorted(
                module
                for module in tree_imports
                if module not in _STDLIB_MODULES
                and module not in _SANDBOX_NATIVE_MODULES
                and module not in libraries
            )
            if missing:
                findings.append(
                    _finding(
                        "warning",
                        "missing_library",
                        f"Node '{node_name}' imports {missing} but python_code.libraries "
                        f"is {sorted(libraries) or '[]'}.",
                        "Add the missing package names to libraries via "
                        "patch_node_libraries (always pass the full list — it replaces).",
                        node=node_name,
                    )
                )

    # -- ports must be null, not [] -------------------------------------------
    for list_key in _VALIDATION_LIST_KEYS:
        for node in graph.get(list_key, []):
            if node.get("ports") == []:
                node_name = node.get("node_name") or str(node.get("id"))
                findings.append(
                    _finding(
                        "warning",
                        "ports_empty_list",
                        f"Node '{node_name}' has ports: [] instead of null.",
                        "The frontend only auto-generates ports when ports is null; "
                        "an empty list suppresses port generation. Set it to null.",
                        node=node_name,
                    )
                )

    # -- metadata-in-sync ("black dots") --------------------------------------
    # start_node_list / end_node_list are the synthetic entry/exit nodes the
    # backend auto-creates for every graph — the canvas never lets a user
    # position them, so an empty metadata dict there is normal, not a stale
    # "black dot" symptom. Every other node type is user-placed and still
    # checked.
    for list_key in _VALIDATION_LIST_KEYS:
        if list_key in ("start_node_list", "end_node_list"):
            continue
        for node in graph.get(list_key, []):
            metadata = node.get("metadata") or {}
            if not metadata or "position" not in metadata:
                node_name = node.get("node_name") or str(node.get("id"))
                findings.append(
                    _finding(
                        "warning",
                        "stale_metadata",
                        f"Node '{node_name}' has no position in metadata.",
                        f"Run init_flow_metadata({graph_id}) — without it this node "
                        "renders as an unstyled node ('black dot') on the canvas.",
                        node=node_name,
                    )
                )

    # -- input_map / output_variable_path continuity --------------------------
    known_shape_paths: set[str] = set()
    for node in start_nodes:
        known_shape_paths |= _flatten_variable_paths(
            _unwrap_start_variables(node), "variables"
        )

    # Root-scoped dynamic writers (`output_variable_path: "variables"`, or a
    # webhook/telegram trigger's runtime-forced root write): infer whatever
    # keys are statically provable from the handler's return dict literal.
    # Exact/ancestor reads of a proven key are folded into known_shape_paths;
    # reads *below* a key whose nested shape isn't a literal are tracked
    # separately so they get downgraded to a warning, not silently passed —
    # see `_path_unverifiable` and `_check_reader`.
    unverifiable_write_paths: set[str] = set()

    def _register_root_writer(python_code: dict[str, Any] | None) -> None:
        code = (python_code or {}).get("code") or ""
        if not code.strip():
            return
        entrypoint = (python_code or {}).get("entrypoint") or "main"
        shape_paths, unverifiable_paths = _infer_root_writer_shape(
            code, entrypoint, "variables"
        )
        known_shape_paths.update(shape_paths)
        unverifiable_write_paths.update(unverifiable_paths)

    for node in graph.get("python_node_list", []):
        if node.get("output_variable_path") == "variables":
            _register_root_writer(node.get("python_code"))
    for node in graph.get("webhook_trigger_node_list", []):
        _register_root_writer(node.get("python_code"))

    # An exact/ancestor read of a proven-but-opaque root-writer key is fully
    # satisfied — only reads *below* it stay unresolved (checked separately
    # in `_check_reader` via the untouched `unverifiable_write_paths`).
    known_shape_paths |= unverifiable_write_paths

    opaque_write_paths: set[str] = set()

    def _register_writer(path: Any) -> None:
        # "variables" (the bare root) is the runtime-forced output_variable_path
        # for webhook/telegram triggers whose handler return shape is dynamic —
        # treating it as a known write would blanket-satisfy every reader in the
        # flow, so it is deliberately excluded rather than tracked as opaque
        # (its provable keys are handled above via _register_root_writer instead).
        if isinstance(path, str) and path and path != "variables":
            opaque_write_paths.add(path)

    for list_key in _IO_NODE_LIST_KEYS:
        for node in graph.get(list_key, []):
            _register_writer(node.get("output_variable_path"))
    for node in cdt_nodes:
        _register_writer(node.get("pre_output_variable_path"))
        _register_writer(node.get("post_output_variable_path"))

    # Platform-injected namespaces: structural guarantees certain trigger/
    # extractor node types provide at runtime, not something the flow author
    # declares anywhere — so they're seeded directly rather than inferred.
    if graph.get("telegram_trigger_node_list"):
        opaque_write_paths.add("variables.telegram_payload")
    if graph.get("file_extractor_node_list") or graph.get("audio_transcription_node_list"):
        opaque_write_paths.add("variables.files")

    # Duplicate-writer detection (bonus continuity check): two nodes writing
    # the same output_variable_path is almost always an override-last-wins
    # bug — unless they sit on different, mutually exclusive branches of a
    # shared CDT/DT router, which is a normal convergence pattern.
    writer_entries: dict[str, list[tuple[int, str]]] = {}
    for list_key in _IO_NODE_LIST_KEYS:
        for node in graph.get(list_key, []):
            path = node.get("output_variable_path")
            node_id = node.get("id")
            if isinstance(path, str) and path and path != "variables" and node_id is not None:
                writer_entries.setdefault(path, []).append(
                    (node_id, node.get("node_name") or str(node_id))
                )

    forward_adjacency = _build_forward_adjacency(graph)
    for path, entries in writer_entries.items():
        if len(entries) <= 1:
            continue
        pairs_exclusive = all(
            _writers_share_exclusive_cdt_branch(
                a_id, b_id, graph, forward_adjacency
            )
            for (a_id, _), (b_id, _) in itertools.combinations(entries, 2)
        )
        if pairs_exclusive:
            continue
        findings.append(
            _finding(
                "warning",
                "duplicate_output_writer",
                f"Path '{path}' is written by multiple nodes: "
                f"{[name for _, name in entries]}.",
                "Confirm this override-last-wins is intentional, or give each "
                "writer a distinct output_variable_path.",
            )
        )

    def _check_reader(
        node_name: str, key: str, path: Any, *, severity: str, code: str
    ) -> None:
        if not isinstance(path, str) or not path.startswith("variables"):
            return
        if _path_satisfied(path, known_shape_paths, opaque_write_paths):
            return
        if severity == "error" and _path_unverifiable(path, unverifiable_write_paths):
            findings.append(
                _finding(
                    "warning",
                    "unverifiable_input_path",
                    f"Node '{node_name}' reads '{key}': '{path}'. An upstream "
                    "node writes the parent key dynamically (its return isn't "
                    "a static dict literal there), so this path's presence at "
                    "runtime can't be confirmed or denied by static analysis.",
                    "Verify at runtime, or restructure the upstream node to "
                    "return a literal dict shape so this can be proven statically.",
                    node=node_name,
                )
            )
            return
        findings.append(
            _finding(
                severity,
                code,
                f"Node '{node_name}' reads '{key}': '{path}', which nothing "
                "upstream (start variables or an output_variable_path) writes.",
                "Declare the path in start variables via patch_start_variables, "
                "or fix the upstream writer/this input_map to agree on the same path.",
                node=node_name,
            )
        )

    for list_key in _IO_NODE_LIST_KEYS:
        for node in graph.get(list_key, []):
            node_name = node.get("node_name") or str(node.get("id"))
            for key, path in (node.get("input_map") or {}).items():
                _check_reader(
                    node_name, key, path, severity="error", code="unwritten_input_path"
                )
    for node in cdt_nodes:
        node_name = node.get("node_name") or str(node.get("id"))
        for key, path in (node.get("pre_input_map") or {}).items():
            _check_reader(
                node_name, key, path, severity="error", code="unwritten_input_path"
            )
        for key, path in (node.get("post_input_map") or {}).items():
            _check_reader(
                node_name, key, path, severity="error", code="unwritten_input_path"
            )
    for edge in graph.get("conditional_edge_list", []):
        source_name = id_to_name.get(edge.get("source_node_id"), "conditional edge")
        for key, path in (edge.get("input_map") or {}).items():
            _check_reader(
                f"conditional edge from '{source_name}'",
                key,
                path,
                severity="error",
                code="unwritten_input_path",
            )

    # End node output_map: a dangling path silently resolves to the literal
    # string "not found" at runtime rather than crashing — warning, not error.
    for node in end_nodes:
        node_name = node.get("node_name") or str(node.get("id"))
        for key, path in (node.get("output_map") or {}).items():
            _check_reader(
                node_name, key, path, severity="warning", code="dangling_output_path"
            )

    return findings


async def validate_flow(graph_id: int) -> dict[str, Any]:
    """Deep, read-only structural validation of a flow — a superset of test_flow.

    Fetches the flow graph and runs the pure `_validate_graph` checks against
    it. Never mutates the flow and never starts a session.

    Returns {"ok": bool, "findings": [{"severity", "code", "node", "message",
    "fix"}], "summary": str}.
    """
    async with get_client() as client:
        graph = await client.get(f"/api/graphs/{graph_id}/")

    findings = _validate_graph(graph)

    error_count = sum(1 for f in findings if f["severity"] == "error")
    ok = error_count == 0
    warning_count = len(findings) - error_count
    summary = (
        "Flow is valid."
        if ok and warning_count == 0
        else f"{error_count} error(s), {warning_count} warning(s) found."
    )
    return {"ok": ok, "findings": findings, "summary": summary}


async def export_flow(flow_id: int) -> dict[str, Any]:
    """Export a flow as a JSON bundle including all dependencies (agents, crews, tools, etc)."""
    async with get_client() as client:
        return await client.get(f"/api/graphs/{flow_id}/export/")


async def bulk_export_flows(flow_ids: list[int]) -> dict[str, Any]:
    """Export multiple flows as a single JSON bundle including all dependencies."""
    async with get_client() as client:
        return await client.post("/api/graphs/bulk-export/", json={"ids": flow_ids})


async def import_flow(
    flow_data: dict[str, Any], preserve_uuids: bool = False
) -> dict[str, Any]:
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
