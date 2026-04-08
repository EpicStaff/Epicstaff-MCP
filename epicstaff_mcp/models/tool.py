"""Pydantic models for EpicStaff Tool resources (MCP and Python)."""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel


class McpTool(BaseModel):
    id: int
    name: str
    transport: str
    tool_name: str
    timeout: float = 30.0
    auth: str | None = None
    init_timeout: float = 10.0


class McpToolCreate(BaseModel):
    name: str
    transport: str
    tool_name: str
    timeout: float = 30.0
    auth: str | None = None
    init_timeout: float = 10.0


class PythonCode(BaseModel):
    id: int
    code: str
    entrypoint: str = "main"
    libraries: list[str] = []
    global_kwargs: dict[str, Any] = {}


class PythonTool(BaseModel):
    id: int
    name: str
    description: str
    args_schema: dict[str, Any]
    python_code: PythonCode
    favorite: bool = False


class PythonToolCreate(BaseModel):
    name: str
    description: str
    args_schema: dict[str, Any]
    python_code: dict[str, Any]
