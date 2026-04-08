"""Pydantic models for EpicStaff Crew resources."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


class Crew(BaseModel):
    id: int
    name: str
    description: str | None = None
    agents: list[int] = []
    process: Literal["sequential", "hierarchical"] = "sequential"
    memory: bool | None = None
    memory_llm_config: int | None = None
    embedding_config: int | None = None
    manager_llm_config: int | None = None
    planning_llm_config: int | None = None
    max_rpm: int | None = None
    cache: bool | None = None
    full_output: bool = False
    planning: bool = False
    default_temperature: float | None = None


class CrewCreate(BaseModel):
    name: str
    description: str | None = None
    agents: list[int] = []
    process: Literal["sequential", "hierarchical"] = "sequential"
    memory: bool | None = None
    memory_llm_config: int | None = None
    embedding_config: int | None = None
    manager_llm_config: int | None = None
    planning_llm_config: int | None = None
    max_rpm: int | None = None
    cache: bool | None = None
    full_output: bool = False
    planning: bool = False
    default_temperature: float | None = None
