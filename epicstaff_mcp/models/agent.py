"""Pydantic models for EpicStaff Agent resources."""
from __future__ import annotations

from pydantic import BaseModel, Field


class Agent(BaseModel):
    id: int
    role: str
    goal: str
    backstory: str
    llm_config: int | None = None
    fcm_llm_config: int | None = None
    knowledge_collection: int | None = None
    max_iter: int | None = None
    max_rpm: int | None = None
    max_execution_time: int | None = None
    memory: bool | None = None
    allow_delegation: bool | None = None
    cache: bool | None = None
    allow_code_execution: bool | None = None
    max_retry_limit: int | None = None
    respect_context_window: bool | None = None
    default_temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    tools: list[dict[str, object]] = Field(default_factory=list)


class AgentCreate(BaseModel):
    role: str
    goal: str
    backstory: str
    llm_config: int | None = None
    fcm_llm_config: int | None = None
    knowledge_collection: int | None = None
    tool_ids: list[str] = Field(default_factory=list)
    max_iter: int | None = None
    max_rpm: int | None = None
    max_execution_time: int | None = None
    memory: bool | None = None
    allow_delegation: bool | None = None
    cache: bool | None = None
    allow_code_execution: bool | None = None
    max_retry_limit: int | None = None
    respect_context_window: bool | None = None
    default_temperature: float | None = Field(default=None, ge=0.0, le=2.0)


class AgentUpdate(BaseModel):
    role: str | None = None
    goal: str | None = None
    backstory: str | None = None
    llm_config: int | None = None
    fcm_llm_config: int | None = None
    knowledge_collection: int | None = None
    tool_ids: list[str] | None = None
    max_iter: int | None = None
    max_rpm: int | None = None
    max_execution_time: int | None = None
    memory: bool | None = None
    allow_delegation: bool | None = None
    cache: bool | None = None
    allow_code_execution: bool | None = None
    max_retry_limit: int | None = None
    respect_context_window: bool | None = None
    default_temperature: float | None = Field(default=None, ge=0.0, le=2.0)
