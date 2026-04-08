"""Pydantic models for EpicStaff LLM and Embedding configuration resources."""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class LLMConfig(BaseModel):
    id: int
    custom_name: str
    model: int | None = None
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    top_p: float | None = None
    max_tokens: int | None = Field(default=None, ge=500)
    presence_penalty: float | None = None
    frequency_penalty: float | None = None
    seed: int | None = None
    api_key: str | None = None
    timeout: float | None = None
    is_visible: bool = True
    headers: dict[str, Any] = {}
    extra_headers: dict[str, Any] = {}


class LLMConfigCreate(BaseModel):
    custom_name: str
    model: int | None = None
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    top_p: float | None = None
    max_tokens: int | None = Field(default=None, ge=500)
    presence_penalty: float | None = None
    frequency_penalty: float | None = None
    seed: int | None = None
    api_key: str | None = None
    timeout: float | None = None
    is_visible: bool = True


class LLMConfigUpdate(BaseModel):
    custom_name: str | None = None
    model: int | None = None
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    top_p: float | None = None
    max_tokens: int | None = Field(default=None, ge=500)
    presence_penalty: float | None = None
    frequency_penalty: float | None = None
    seed: int | None = None
    api_key: str | None = None
    timeout: float | None = None
    is_visible: bool | None = None


class Provider(BaseModel):
    id: int
    name: str


class EmbeddingConfig(BaseModel):
    model_config = {"extra": "allow"}
    id: int
