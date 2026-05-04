"""Pydantic models for EpicStaff Flow (Graph) resources."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel

NodeType = Literal[
    "crewnode", "pythonnode", "startnode", "endnode",
    "subgraphnode", "codeagentnode", "fileextractornode",
    "audiotranscriptionnode", "decisiontablenode",
    "telegramtriggernode", "webhooktriggernode",
]


class NodeBase(BaseModel):
    id: int
    graph: int
    node_name: str
    input_map: dict[str, Any] = {}
    output_variable_path: str | None = None
    metadata: dict[str, Any] = {}


class CrewNode(NodeBase):
    crew_id: int
    stream_config: dict[str, Any] = {}


class PythonNode(NodeBase):
    python_code: dict[str, Any]
    stream_config: dict[str, Any] = {}


class StartNode(NodeBase):
    variables: dict[str, Any] = {}


class EndNode(NodeBase):
    output_map: dict[str, Any]


class Edge(BaseModel):
    id: int
    graph: int
    start_node_id: int
    end_node_id: int


class ConditionalEdge(BaseModel):
    id: int
    graph: int
    source_node_id: int | None = None
    python_code: dict[str, Any]
    input_map: dict[str, Any] = {}


class FlowLight(BaseModel):
    id: int
    name: str
    description: str | None = None
    tags: list[dict[str, Any]] = []
    epicchat_enabled: bool = False
    created_at: str
    updated_at: str


class Flow(BaseModel):
    id: int
    uuid: str
    name: str
    description: str | None = None
    metadata: dict[str, Any] = {}
    time_to_live: int = 3600
    persistent_variables: bool = False
    epicchat_enabled: bool = False
    created_at: str
    updated_at: str
    crew_node_list: list[dict[str, Any]] = []
    python_node_list: list[dict[str, Any]] = []
    start_node_list: list[dict[str, Any]] = []
    end_node_list: list[dict[str, Any]] = []
    subgraph_node_list: list[dict[str, Any]] = []
    code_agent_node_list: list[dict[str, Any]] = []
    file_extractor_node_list: list[dict[str, Any]] = []
    audio_transcription_node_list: list[dict[str, Any]] = []
    decision_table_node_list: list[dict[str, Any]] = []
    telegram_trigger_node_list: list[dict[str, Any]] = []
    webhook_trigger_node_list: list[dict[str, Any]] = []
    edge_list: list[dict[str, Any]] = []
    conditional_edge_list: list[dict[str, Any]] = []


class FlowCreate(BaseModel):
    name: str
    description: str | None = None
    epicchat_enabled: bool = False


class FlowMetadataUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    epicchat_enabled: bool | None = None


class NodeCreate(BaseModel):
    node_type: NodeType
    config: dict[str, Any]


class EdgeCreate(BaseModel):
    start_node_id: int
    end_node_id: int


class ConditionalEdgeCreate(BaseModel):
    source_node_id: int | None = None
    python_code: dict[str, Any]
    input_map: dict[str, Any] = {}
