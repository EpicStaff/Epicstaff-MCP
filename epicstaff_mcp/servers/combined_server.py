"""EpicStaff MCP Combined Server — registers all tools and starts the server."""

from __future__ import annotations

from fastmcp import FastMCP

from epicstaff_mcp.tools import (
    agent_definitions,
    agents,
    auth,
    config,
    flow_runtime,
    crews,
    flow_compiler,
    flows,
    knowledge,
    llm_configs,
    memory,
    organizations,
    python_code,
    realtime,
    session_debug,
    sessions,
    storage,
    surfaces,
    tasks,
    tools,
    webhooks,
)

mcp = FastMCP("EpicStaff")

# Agents
mcp.tool(agents.list_agents)
mcp.tool(agents.get_agent)
mcp.tool(agents.create_agent)
mcp.tool(agents.update_agent)
mcp.tool(agents.delete_agent)
mcp.tool(agents.copy_agent)
mcp.tool(agents.list_template_agents)
mcp.tool(agents.get_template_agent)
mcp.tool(agents.list_agent_tags)
mcp.tool(agents.create_agent_tag)
mcp.tool(agents.delete_agent_tag)

# Crews
mcp.tool(crews.list_crews)
mcp.tool(crews.get_crew)
mcp.tool(crews.create_crew)
mcp.tool(crews.update_crew)
mcp.tool(crews.delete_crew)
mcp.tool(crews.copy_crew)
mcp.tool(crews.list_crew_tags)
mcp.tool(crews.create_crew_tag)
mcp.tool(crews.delete_crew_tag)

# Flows
mcp.tool(flows.list_flows)
mcp.tool(flows.get_flow)
mcp.tool(flows.create_flow)
mcp.tool(flows.update_flow_metadata)
mcp.tool(flows.init_flow_metadata)
mcp.tool(flows.get_flow_nodes)
mcp.tool(flows.get_flow_connections)
mcp.tool(flows.add_node)
mcp.tool(flows.update_node)
mcp.tool(flows.delete_node)
mcp.tool(flows.add_agent_node_task)
mcp.tool(flows.list_edges)
mcp.tool(flows.add_edge)
mcp.tool(flows.delete_edge)
mcp.tool(flows.add_conditional_edge)
mcp.tool(flows.copy_flow)
mcp.tool(flows.save_flow)
mcp.tool(flows.delete_flow)
mcp.tool(flows.test_flow)
mcp.tool(flows.validate_flow)
mcp.tool(flows.get_graph_run_status)
mcp.tool(flows.get_schedule_trigger_node)
# Flow node patch helpers
mcp.tool(flows.get_cdt_node)
mcp.tool(flows.get_cdt_prompts)
mcp.tool(flows.get_cdt_route_map)
mcp.tool(flows.patch_cdt_node)
mcp.tool(flows.patch_dt_node)
mcp.tool(flows.patch_python_node)
mcp.tool(flows.patch_code_agent_node)
mcp.tool(flows.patch_webhook_node)
mcp.tool(flows.patch_node_libraries)
mcp.tool(flows.patch_node_metadata)
mcp.tool(flows.patch_start_variables)
# Graph tags & notes
mcp.tool(flows.list_graph_tags)
mcp.tool(flows.create_graph_tag)
mcp.tool(flows.delete_graph_tag)
mcp.tool(flows.list_graph_notes)
mcp.tool(flows.create_graph_note)
mcp.tool(flows.update_graph_note)
mcp.tool(flows.delete_graph_note)
# Graph versions
mcp.tool(flows.list_graph_versions)
mcp.tool(flows.get_graph_version)
mcp.tool(flows.save_graph_version)
mcp.tool(flows.update_graph_version)
mcp.tool(flows.restore_graph_version)
mcp.tool(flows.create_graph_from_version)
# Import / export
mcp.tool(flows.export_flow)
mcp.tool(flows.bulk_export_flows)
mcp.tool(flows.import_flow)

# Flow compiler (spec -> local validation -> one atomic bulk save)
mcp.tool(flow_compiler.create_flow_from_spec)
mcp.tool(flow_compiler.get_flow_spec_schema)

# Sessions
mcp.tool(sessions.list_sessions)
mcp.tool(sessions.get_session)
mcp.tool(sessions.run_session)
mcp.tool(sessions.run_session_and_wait)
mcp.tool(sessions.get_session_updates)
mcp.tool(sessions.stop_session)
mcp.tool(sessions.send_message)
mcp.tool(sessions.delete_session)
mcp.tool(sessions.get_session_warnings)
mcp.tool(sessions.list_session_messages)

# Session debug
mcp.tool(session_debug.inspect_session)
mcp.tool(session_debug.get_session_timings)
mcp.tool(session_debug.get_session_trace)
mcp.tool(session_debug.get_session_crew_input)
mcp.tool(session_debug.get_flow_persistent_vars)

# Storage (MinIO/S3-backed file store + flow attachment)
mcp.tool(storage.list_storage)
mcp.tool(storage.storage_tree)
mcp.tool(storage.get_storage_info)
mcp.tool(storage.create_storage_folder)
mcp.tool(storage.upload_storage_file)
mcp.tool(storage.delete_storage_paths)
mcp.tool(storage.rename_storage)
mcp.tool(storage.move_storage)
mcp.tool(storage.copy_storage)
mcp.tool(storage.attach_storage_to_flow)
mcp.tool(storage.detach_storage_from_flow)
mcp.tool(storage.list_flow_storage)

# Tools
mcp.tool(tools.list_tools)
mcp.tool(tools.get_tool)
mcp.tool(tools.create_mcp_tool)
mcp.tool(tools.create_python_tool)
mcp.tool(tools.update_mcp_tool)
mcp.tool(tools.update_python_tool)
mcp.tool(tools.delete_tool)
mcp.tool(tools.copy_tool)

# Knowledge
mcp.tool(knowledge.list_source_collections)
mcp.tool(knowledge.create_source_collection)
mcp.tool(knowledge.get_source_collection)
mcp.tool(knowledge.update_source_collection)
mcp.tool(knowledge.delete_source_collection)
mcp.tool(knowledge.copy_source_collection)
mcp.tool(knowledge.trigger_rag_indexing)
mcp.tool(knowledge.list_documents)
mcp.tool(knowledge.delete_document)
mcp.tool(knowledge.list_collection_documents)
mcp.tool(knowledge.get_document)
mcp.tool(knowledge.bulk_delete_documents)
mcp.tool(knowledge.upload_document_file)
mcp.tool(knowledge.list_naive_rag_for_collection)
mcp.tool(knowledge.create_naive_rag)
mcp.tool(knowledge.get_naive_rag)
mcp.tool(knowledge.delete_naive_rag)
mcp.tool(knowledge.init_naive_rag_document_configs)
mcp.tool(knowledge.list_naive_rag_document_configs)
mcp.tool(knowledge.get_naive_rag_document_config)
mcp.tool(knowledge.update_naive_rag_document_config)
mcp.tool(knowledge.delete_naive_rag_document_config)
mcp.tool(knowledge.bulk_update_naive_rag_document_configs)
mcp.tool(knowledge.bulk_delete_naive_rag_document_configs)
mcp.tool(knowledge.process_chunking)
mcp.tool(knowledge.list_naive_rag_chunks)
mcp.tool(knowledge.list_naive_rag_document_chunks)
mcp.tool(knowledge.list_labels)
mcp.tool(knowledge.create_label)
mcp.tool(knowledge.delete_label)
# Graph RAG
mcp.tool(knowledge.list_available_rags)
mcp.tool(knowledge.create_graph_rag)
mcp.tool(knowledge.get_graph_rag)
mcp.tool(knowledge.delete_graph_rag)
mcp.tool(knowledge.update_graph_rag_index_config)

# LLM Configs
mcp.tool(llm_configs.list_llm_configs)
mcp.tool(llm_configs.get_llm_config)
mcp.tool(llm_configs.create_llm_config)
mcp.tool(llm_configs.update_llm_config)
mcp.tool(llm_configs.delete_llm_config)
mcp.tool(llm_configs.list_embedding_configs)
mcp.tool(llm_configs.create_embedding_config)
mcp.tool(llm_configs.get_embedding_config)
mcp.tool(llm_configs.update_embedding_config)
mcp.tool(llm_configs.delete_embedding_config)
mcp.tool(llm_configs.list_llm_models)
mcp.tool(llm_configs.list_embedding_models)

# Tasks
mcp.tool(tasks.list_tasks)
mcp.tool(tasks.get_task)
mcp.tool(tasks.create_task)
mcp.tool(tasks.update_task)
mcp.tool(tasks.delete_task)

# Memory
mcp.tool(memory.list_memories)
mcp.tool(memory.delete_memory)

# Python Code
mcp.tool(python_code.list_python_code)
mcp.tool(python_code.get_python_code)
mcp.tool(python_code.create_python_code)
mcp.tool(python_code.update_python_code)
mcp.tool(python_code.delete_python_code)
mcp.tool(python_code.run_python_code)
mcp.tool(python_code.list_python_code_results)
mcp.tool(python_code.get_python_code_result)

# Realtime
mcp.tool(realtime.list_realtime_models)
mcp.tool(realtime.list_realtime_model_configs)
mcp.tool(realtime.get_realtime_model_config)
mcp.tool(realtime.create_realtime_model_config)
mcp.tool(realtime.update_realtime_model_config)
mcp.tool(realtime.delete_realtime_model_config)
mcp.tool(realtime.list_realtime_transcription_models)
mcp.tool(realtime.list_realtime_transcription_model_configs)
mcp.tool(realtime.create_realtime_transcription_model_config)
mcp.tool(realtime.update_realtime_transcription_model_config)
mcp.tool(realtime.delete_realtime_transcription_model_config)
mcp.tool(realtime.list_realtime_agents)
mcp.tool(realtime.get_realtime_agent)
mcp.tool(realtime.create_realtime_agent)
mcp.tool(realtime.update_realtime_agent)
mcp.tool(realtime.delete_realtime_agent)
mcp.tool(realtime.list_realtime_agent_chats)
mcp.tool(realtime.list_realtime_session_items)
mcp.tool(realtime.init_realtime)

# Webhooks & Triggers
mcp.tool(webhooks.list_webhook_triggers)
mcp.tool(webhooks.get_webhook_trigger)
mcp.tool(webhooks.create_webhook_trigger)
mcp.tool(webhooks.update_webhook_trigger)
mcp.tool(webhooks.delete_webhook_trigger)
mcp.tool(webhooks.register_webhooks)
mcp.tool(webhooks.list_webhook_trigger_nodes)
mcp.tool(webhooks.list_telegram_trigger_nodes)
mcp.tool(webhooks.get_telegram_trigger_node)
mcp.tool(webhooks.list_telegram_trigger_node_fields)
mcp.tool(webhooks.list_telegram_available_fields)
mcp.tool(webhooks.register_telegram_trigger)
mcp.tool(webhooks.get_ngrok_config)
mcp.tool(webhooks.update_ngrok_config)

# Organizations
mcp.tool(organizations.list_organizations)
mcp.tool(organizations.get_organization)
mcp.tool(organizations.create_organization)
mcp.tool(organizations.update_organization)
mcp.tool(organizations.delete_organization)
mcp.tool(organizations.deactivate_organization)
mcp.tool(organizations.list_organization_users)
mcp.tool(organizations.add_organization_user)
mcp.tool(organizations.remove_organization_user)
mcp.tool(organizations.list_graph_organizations)
mcp.tool(organizations.add_graph_organization)
mcp.tool(organizations.remove_graph_organization)
mcp.tool(organizations.list_graph_organization_users)
mcp.tool(organizations.set_active_organization)
mcp.tool(organizations.get_active_organization)
mcp.tool(organizations.clear_active_organization)
mcp.tool(organizations.list_my_organizations)

# Agent Definitions
mcp.tool(agent_definitions.list_agent_definitions)
mcp.tool(agent_definitions.get_agent_definition)
mcp.tool(agent_definitions.create_agent_definition)
mcp.tool(agent_definitions.update_agent_definition)
mcp.tool(agent_definitions.delete_agent_definition)

# Surfaces
mcp.tool(surfaces.list_surfaces)
mcp.tool(surfaces.get_surface)
mcp.tool(surfaces.create_surface)
mcp.tool(surfaces.update_surface)
mcp.tool(surfaces.delete_surface)
mcp.tool(surfaces.combine_surfaces)

# Config / Health
mcp.tool(config.ping)
mcp.tool(config.list_providers)
mcp.tool(config.list_env_vars)
mcp.tool(config.set_env_vars)
mcp.tool(config.delete_env_var)
mcp.tool(config.get_default_configs)
mcp.tool(config.update_default_llm_config)
mcp.tool(config.get_default_llm_config)
mcp.tool(config.get_default_embedding_config)
mcp.tool(config.update_default_embedding_config)
mcp.tool(config.get_default_agent_config)
mcp.tool(config.update_default_agent_config)
mcp.tool(config.get_default_crew_config)
mcp.tool(config.update_default_crew_config)
mcp.tool(config.get_default_tool_config)
mcp.tool(config.update_default_tool_config)
mcp.tool(config.get_quickstart)

# Auth / API keys
mcp.tool(auth.create_api_key)

# Runnable gate
mcp.tool(flow_runtime.smoke_test_flow)


def main() -> None:
    """Start the EpicStaff MCP server with stdio transport."""
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
