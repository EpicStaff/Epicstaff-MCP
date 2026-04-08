"""Shared pagination model for EpicStaff API list responses."""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel


class PaginatedResponse(BaseModel):
    count: int
    next: str | None = None
    previous: str | None = None
    results: list[dict[str, Any]]
