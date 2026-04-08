"""Pydantic models for EpicStaff Session resources."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, model_validator

SessionStatus = Literal["pending", "run", "wait_for_user", "error", "end", "stop", "expired"]


class Session(BaseModel):
    id: int
    graph_id: int
    status: SessionStatus
    status_updated_at: str
    status_data: dict[str, Any] = {}
    variables: dict[str, Any] = {}
    created_at: str
    finished_at: str | None = None
    token_usage: dict[str, Any] = {}


class SessionLight(BaseModel):
    id: int
    graph_id: int
    status: SessionStatus
    status_updated_at: str
    created_at: str
    finished_at: str | None = None


class RunSessionRequest(BaseModel):
    graph_id: int | None = None
    graph_uuid: str | None = None
    variables: dict[str, Any] = {}

    @model_validator(mode="after")
    def require_graph_id_or_uuid(self) -> RunSessionRequest:
        if not self.graph_id and not self.graph_uuid:
            raise ValueError("Either graph_id or graph_uuid must be provided")
        return self
