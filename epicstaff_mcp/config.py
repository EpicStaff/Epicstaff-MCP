"""Environment-variable configuration for the EpicStaff MCP server."""

from __future__ import annotations

from enum import StrEnum
from functools import lru_cache

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class AuthMode(StrEnum):
    NONE = "none"
    BASIC = "basic"
    API_KEY = "api_key"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="EPICSTAFF_", case_sensitive=False)

    base_url: str  # required — no default forces explicit configuration
    api_token: str | None = None
    username: str | None = None
    password: str | None = None
    timeout: float = 30.0
    max_retries: int = 3

    @field_validator("api_token", "username", "password", mode="before")
    @classmethod
    def empty_str_to_none(cls, v: object) -> object:
        if isinstance(v, str) and v == "":
            return None
        return v

    @field_validator("base_url", mode="after")
    @classmethod
    def normalise_base_url(cls, v: str) -> str:
        if not v.startswith(("http://", "https://")):
            raise ValueError("EPICSTAFF_BASE_URL must start with http:// or https://")
        return v.rstrip("/") + "/"

    @model_validator(mode="after")
    def validate_auth(self) -> Settings:
        has_token = self.api_token is not None
        has_user = self.username is not None
        has_pass = self.password is not None

        if has_user and not has_pass:
            raise ValueError(
                "Both EPICSTAFF_USERNAME and EPICSTAFF_PASSWORD must be set together"
            )
        if has_pass and not has_user:
            raise ValueError(
                "Both EPICSTAFF_USERNAME and EPICSTAFF_PASSWORD must be set together"
            )
        if has_token and (has_user or has_pass):
            raise ValueError(
                "Ambiguous auth config — set either EPICSTAFF_API_TOKEN or "
                "EPICSTAFF_USERNAME/EPICSTAFF_PASSWORD, not both"
            )
        return self

    @property
    def auth_mode(self) -> AuthMode:
        if self.api_token:
            return AuthMode.API_KEY
        if self.username and self.password:
            return AuthMode.BASIC
        return AuthMode.NONE


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
