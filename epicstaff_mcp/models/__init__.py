"""Pydantic models for EpicStaff API resources."""
from __future__ import annotations

from epicstaff_mcp.models.agent import Agent, AgentCreate, AgentUpdate
from epicstaff_mcp.models.common import PaginatedResponse
from epicstaff_mcp.models.crew import Crew, CrewCreate
from epicstaff_mcp.models.flow import (
    ConditionalEdge,
    ConditionalEdgeCreate,
    CrewNode,
    Edge,
    EdgeCreate,
    EndNode,
    Flow,
    FlowCreate,
    FlowLight,
    FlowMetadataUpdate,
    LLMNode,
    NodeBase,
    NodeCreate,
    NodeType,
    PythonNode,
    StartNode,
)
from epicstaff_mcp.models.knowledge import (
    CollectionOrigin,
    CollectionStatus,
    SourceCollection,
    SourceCollectionCreate,
)
from epicstaff_mcp.models.llm_config import (
    EmbeddingConfig,
    LLMConfig,
    LLMConfigCreate,
    LLMConfigUpdate,
    Provider,
)
from epicstaff_mcp.models.session import (
    RunSessionRequest,
    Session,
    SessionLight,
    SessionStatus,
)
from epicstaff_mcp.models.tool import (
    McpTool,
    McpToolCreate,
    PythonCode,
    PythonTool,
    PythonToolCreate,
)

__all__ = [
    # Common
    "PaginatedResponse",
    # Agent
    "Agent",
    "AgentCreate",
    "AgentUpdate",
    # Crew
    "Crew",
    "CrewCreate",
    # Flow
    "NodeType",
    "NodeBase",
    "CrewNode",
    "LLMNode",
    "PythonNode",
    "StartNode",
    "EndNode",
    "Edge",
    "ConditionalEdge",
    "FlowLight",
    "Flow",
    "FlowCreate",
    "FlowMetadataUpdate",
    "NodeCreate",
    "EdgeCreate",
    "ConditionalEdgeCreate",
    # Session
    "SessionStatus",
    "Session",
    "SessionLight",
    "RunSessionRequest",
    # Tool
    "McpTool",
    "McpToolCreate",
    "PythonCode",
    "PythonTool",
    "PythonToolCreate",
    # Knowledge
    "CollectionStatus",
    "CollectionOrigin",
    "SourceCollection",
    "SourceCollectionCreate",
    # LLM Config
    "LLMConfig",
    "LLMConfigCreate",
    "LLMConfigUpdate",
    "Provider",
    "EmbeddingConfig",
]
