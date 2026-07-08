"""EpicStaff MCP Server — registers all tools and starts the server."""

from __future__ import annotations

from fastmcp import FastMCP

from epicstaff_mcp.tools import (
    agents,
    config,
    crews,
    flows,
    knowledge,
    llm_configs,
    sessions,
    tools,
)

mcp = FastMCP("EpicStaff")

# Agents
mcp.tool(agents.list_agents)
mcp.tool(agents.get_agent)
mcp.tool(agents.create_agent)
mcp.tool(agents.update_agent)
mcp.tool(agents.delete_agent)

# Crews
mcp.tool(crews.list_crews)
mcp.tool(crews.get_crew)
mcp.tool(crews.create_crew)
mcp.tool(crews.update_crew)
mcp.tool(crews.delete_crew)

# Flows
mcp.tool(flows.list_flows)
mcp.tool(flows.get_flow)
mcp.tool(flows.create_flow)
mcp.tool(flows.update_flow_metadata)
mcp.tool(flows.get_flow_nodes)
mcp.tool(flows.add_node)
mcp.tool(flows.update_node)
mcp.tool(flows.delete_node)
mcp.tool(flows.list_edges)
mcp.tool(flows.add_edge)
mcp.tool(flows.delete_edge)

# Sessions
mcp.tool(sessions.list_sessions)
mcp.tool(sessions.run_session)
mcp.tool(sessions.get_session_updates)
mcp.tool(sessions.stop_session)
mcp.tool(sessions.send_message)

# Tools
mcp.tool(tools.list_tools)
mcp.tool(tools.get_tool)
mcp.tool(tools.create_mcp_tool)
mcp.tool(tools.create_python_tool)
mcp.tool(tools.update_mcp_tool)
mcp.tool(tools.update_python_tool)
mcp.tool(tools.delete_tool)

# Knowledge
mcp.tool(knowledge.list_source_collections)
mcp.tool(knowledge.create_source_collection)
mcp.tool(knowledge.trigger_rag_indexing)

# LLM Configs
mcp.tool(llm_configs.list_llm_configs)
mcp.tool(llm_configs.get_llm_config)
mcp.tool(llm_configs.create_llm_config)
mcp.tool(llm_configs.update_llm_config)
mcp.tool(llm_configs.delete_llm_config)
mcp.tool(llm_configs.list_embedding_configs)
mcp.tool(llm_configs.create_embedding_config)

# Config / Health
mcp.tool(config.ping)
mcp.tool(config.list_providers)


def main() -> None:
    """Start the EpicStaff MCP server with stdio transport."""
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
