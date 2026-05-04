"""HTTP client for the EpicStaff REST API — handles auth, retries, and error translation."""
from __future__ import annotations

import base64
from types import TracebackType
from typing import Any

import httpx
from tenacity import AsyncRetrying, retry_if_exception, stop_after_attempt, wait_exponential

from epicstaff_mcp.config import AuthMode, Settings, get_settings
from epicstaff_mcp.exceptions import (
    EpicStaffAPIError,
    EpicStaffConnectionError,
    EpicStaffNotFoundError,
)


def _is_retryable(exc: BaseException) -> bool:
    if isinstance(exc, (httpx.TransportError, EpicStaffConnectionError)):
        return True
    return isinstance(exc, EpicStaffAPIError) and exc.status_code >= 500


class EpicStaffClient:
    def __init__(self, settings: Settings | None = None) -> None:
        self._settings = settings or get_settings()
        self._http: httpx.AsyncClient | None = None

    def _build_auth_headers(self) -> dict[str, str]:
        s = self._settings
        if s.auth_mode == AuthMode.API_KEY:
            return {"Authorization": f"Bearer {s.api_token}"}
        if s.auth_mode == AuthMode.BASIC:
            encoded = base64.b64encode(f"{s.username}:{s.password}".encode()).decode()
            return {"Authorization": f"Basic {encoded}"}
        return {}

    async def __aenter__(self) -> EpicStaffClient:
        self._http = httpx.AsyncClient(
            base_url=self._settings.base_url,
            headers={"Content-Type": "application/json", **self._build_auth_headers()},
            timeout=self._settings.timeout,
        )
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        if self._http:
            await self._http.aclose()
            self._http = None  # reset so guard works if client is reused

    def _raise_for_status(self, response: httpx.Response) -> None:
        if response.status_code == 404:
            try:
                detail = response.json().get("detail", "Not found")
            except Exception:
                detail = "Not found"
            raise EpicStaffNotFoundError(detail=detail)
        if response.is_error:
            try:
                detail = str(response.json())
            except Exception:
                detail = response.text
            raise EpicStaffAPIError(status_code=response.status_code, detail=detail)

    async def _request(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        if self._http is None:
            raise RuntimeError("Client not started — use async with EpicStaffClient()")

        # httpx derives the Host header from base_url per-request, overriding client-level headers.
        # Docker service names with underscores (e.g. django_app) fail Django's RFC 1034/1035
        # hostname validation even when ALLOWED_HOSTS = ["*"]. Inject Host: localhost only when
        # the hostname contains underscores (Docker-only issue; no-op on real server hostnames).
        from urllib.parse import urlparse
        _hostname = urlparse(self._settings.base_url).hostname or ""
        if "_" in _hostname:
            kwargs["headers"] = {"Host": "localhost", **kwargs.get("headers", {})}

        async for attempt in AsyncRetrying(
            retry=retry_if_exception(_is_retryable),
            stop=stop_after_attempt(self._settings.max_retries),
            wait=wait_exponential(multiplier=1, min=1, max=10),
            reraise=True,
        ):
            with attempt:
                try:
                    response = await self._http.request(method, path, **kwargs)
                except httpx.TransportError as exc:
                    raise EpicStaffConnectionError(
                        f"Cannot reach EpicStaff at {self._settings.base_url}: {exc}"
                    ) from exc
                self._raise_for_status(response)
                if response.status_code == 204 or not response.content:
                    return {}
                result = response.json()
                return result if isinstance(result, dict) else {"results": result}  # type: ignore[no-any-return]

        raise RuntimeError("Retry loop exited without returning")  # unreachable

    async def get(self, path: str, **kwargs: Any) -> dict[str, Any]:
        return await self._request("GET", path, **kwargs)

    async def post(self, path: str, **kwargs: Any) -> dict[str, Any]:
        return await self._request("POST", path, **kwargs)

    async def patch(self, path: str, **kwargs: Any) -> dict[str, Any]:
        return await self._request("PATCH", path, **kwargs)

    async def put(self, path: str, **kwargs: Any) -> dict[str, Any]:
        return await self._request("PUT", path, **kwargs)

    async def delete(self, path: str, **kwargs: Any) -> dict[str, Any]:
        return await self._request("DELETE", path, **kwargs)

    async def post_multipart(self, path: str, **kwargs: Any) -> dict[str, Any]:
        """POST with multipart/form-data. Does not set Content-Type — httpx sets it automatically."""
        if self._http is None:
            raise RuntimeError("Client not started — use async with EpicStaffClient()")
        # Temporarily remove the json Content-Type so httpx can set multipart boundary
        original_ct = self._http.headers.get("content-type")
        del self._http.headers["content-type"]
        try:
            return await self._request("POST", path, **kwargs)
        finally:
            if original_ct:
                self._http.headers["content-type"] = original_ct


# Module-level singleton used by tool functions
_client: EpicStaffClient | None = None


def get_client() -> EpicStaffClient:
    global _client
    if _client is None:
        _client = EpicStaffClient()
    return _client
