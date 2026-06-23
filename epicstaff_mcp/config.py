"""Environment-variable configuration for the EpicStaff MCP server."""

from __future__ import annotations

from enum import StrEnum
from functools import lru_cache

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class AuthMode(StrEnum):
    NONE = "none"
    BASIC = "basic"
    API_KEY = "api_key"  # bearer token (JWT) via Authorization: Bearer
    X_API_KEY = "x_api_key"  # EpicStaff API key via X-Api-Key header


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="EPICSTAFF_", case_sensitive=False)

    base_url: str  # required — no default forces explicit configuration
    api_token: str | None = None  # JWT bearer token
    api_key: str | None = None  # EpicStaff API key (sent as X-Api-Key)
    username: str | None = None
    password: str | None = None
    timeout: float = 30.0
    max_retries: int = 3

    @field_validator("api_token", "api_key", "username", "password", mode="before")
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
        has_api_key = self.api_key is not None
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
        # Exactly one auth method at most. Count basic creds as one method.
        methods_set = sum([has_token, has_api_key, has_user or has_pass])
        if methods_set > 1:
            raise ValueError(
                "Ambiguous auth config — set exactly one of EPICSTAFF_API_TOKEN, "
                "EPICSTAFF_API_KEY, or EPICSTAFF_USERNAME/EPICSTAFF_PASSWORD"
            )
        return self

    @property
    def auth_mode(self) -> AuthMode:
        if self.api_key:
            return AuthMode.X_API_KEY
        if self.api_token:
            return AuthMode.API_KEY
        if self.username and self.password:
            return AuthMode.BASIC
        return AuthMode.NONE


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
