"""MCP tools for managing EpicStaff flows (visual workflows) including nodes and edges."""
from __future__ import annotations

from typing import Any

from epicstaff_mcp.client import get_client
from epicstaff_mcp.exceptions import EpicStaffAPIError

# Maps node_type string to the API endpoint prefix
NODE_TYPE_TO_ENDPOINT: dict[str, str] = {
    "llmnode": "llmnodes",
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
) -> dict[str, Any]:
    """Add a node to a flow.

    node_type must be one of: llmnode, crewnode, pythonnode, startnode, endnode,
    subgraphnode, codeagentnode, fileextractornode, audiotranscriptionnode,
    decisiontablenode, telegramtriggernode, webhooktriggernode

    config keys by node_type:
      crewnode:   {crew_id: int}
      llmnode:    {llm_config: int}
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
    payload = {"graph": flow_id, **config}
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
