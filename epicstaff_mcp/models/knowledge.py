"""Pydantic models for EpicStaff Knowledge/RAG resources."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

CollectionStatus = Literal["empty", "uploading", "completed", "warning"]
CollectionOrigin = Literal["user", "node", "tool"]


class SourceCollection(BaseModel):
    collection_id: int
    collection_name: str
    collection_origin: CollectionOrigin = "user"
    status: CollectionStatus = "empty"
    created_at: str
    updated_at: str


class SourceCollectionCreate(BaseModel):
    collection_name: str
    embedding_config: int | None = None
