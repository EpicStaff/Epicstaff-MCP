"""HTTP client for the EpicStaff REST API — handles auth, retries, and error translation."""

from __future__ import annotations

import asyncio
from types import TracebackType
from typing import Any

import httpx
from tenacity import (
    AsyncRetrying,
    retry_if_exception,
    stop_after_attempt,
    wait_exponential,
)

from epicstaff_mcp.config import AuthMode, Settings, get_settings
from epicstaff_mcp.error_remediation import find_remediation
from epicstaff_mcp.exceptions import (
    EpicStaffAPIError,
    EpicStaffConnectionError,
    EpicStaffNotFoundError,
)


def _is_retryable(exc: BaseException) -> bool:
    if isinstance(exc, (httpx.TransportError, EpicStaffConnectionError)):
        return True
    return isinstance(exc, EpicStaffAPIError) and exc.status_code >= 500


# Runtime active-organization override for the X-Organization-Id RBAC header.
# _override_set distinguishes "never set" (fall back to the auto-resolved default)
# from an explicit set_active_org_id(None) that clears back to that default.
_active_org_id: int | None = None
_override_set: bool = False

# Auto-resolved default organization (mirrors the Angular frontend's bootstrap):
# the first membership returned by GET /api/profile/ when no override is set.
# _default_resolved distinguishes "not attempted yet" from "attempted, resolved to None".
_resolved_default_org_id: int | None = None
_default_resolved: bool = False


def set_active_org_id(org_id: int | None) -> None:
    """Set the runtime active organization override used for the X-Organization-Id header."""
    global _active_org_id, _override_set
    _active_org_id = org_id
    _override_set = True


def set_resolved_default_org_id(org_id: int | None) -> None:
    """Record the outcome of auto-resolving a default organization from /api/profile/."""
    global _resolved_default_org_id, _default_resolved
    _resolved_default_org_id = org_id
    _default_resolved = True


def get_active_org_id() -> int | None:
    """Return the active organization id.

    Resolution precedence:
      1. the runtime override, when it has been explicitly set (even to None)
      2. the auto-resolved default from GET /api/profile/, once resolved
      3. None
    """
    if _override_set:
        return _active_org_id
    if _default_resolved:
        return _resolved_default_org_id
    return None


class EpicStaffClient:
    def __init__(self, settings: Settings | None = None) -> None:
        self._settings = settings or get_settings()
        self._http: httpx.AsyncClient | None = None
        # JWT state for BASIC (username/password) mode. Not touched by
        # __aenter__/__aexit__ so tokens survive `async with` re-entries on the
        # module-level singleton — only the httpx client is rebuilt per entry.
        self._access: str | None = None
        self._refresh: str | None = None
        self._auth_lock = asyncio.Lock()
        self._org_lock = asyncio.Lock()

    def _build_auth_headers(self) -> dict[str, str]:
        s = self._settings
        # API_KEY mode uses a static Bearer token set at client level. BASIC mode
        # authenticates lazily via JWT login and injects the Bearer per request
        # (see _ensure_auth / _request), so it contributes no client-level header.
        if s.auth_mode == AuthMode.API_KEY:
            return {"Authorization": f"Bearer {s.api_token}"}
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

    async def _login(self) -> None:
        """Authenticate with username/password and cache the JWT pair.

        Uses _skip_auth so it neither injects a Bearer header (the login endpoint
        is unauthenticated) nor recurses into the 401 re-auth handler.
        """
        result = await self._request(
            "POST",
            "/api/auth/login/",
            json={
                "email": self._settings.username,
                "password": self._settings.password,
            },
            _skip_auth=True,
        )
        self._access = result["access"]
        self._refresh = result["refresh"]

    async def _refresh_access(self) -> None:
        """Exchange the cached refresh token for a fresh access token."""
        result = await self._request(
            "POST",
            "/api/auth/refresh/",
            json={"refresh": self._refresh},
            _skip_auth=True,
        )
        self._access = result["access"]

    async def _ensure_auth(self) -> None:
        """Lazily obtain a JWT access token in BASIC mode (double-checked)."""
        if self._settings.auth_mode != AuthMode.BASIC or self._access is not None:
            return
        async with self._auth_lock:
            if self._access is None:
                await self._login()

    async def _ensure_active_org(self) -> None:
        """Lazily auto-resolve a default active organization from /api/profile/.

        Mirrors the Angular frontend's bootstrap: when no explicit override is set,
        adopt the caller's first org membership so org-scoped calls don't fail with
        "X-Organization-Id header is required". No-op when unauthenticated (NONE
        mode has no user to look up), when an explicit override already resolves
        the active org, or once a default has already been resolved
        (double-checked, like _ensure_auth).
        """
        if self._settings.auth_mode == AuthMode.NONE:
            return
        if _override_set or _default_resolved:
            return
        async with self._org_lock:
            if _override_set or _default_resolved:
                return
            profile = await self.get("/api/profile/", _skip_org=True)
            memberships = profile.get("memberships") or []
            active_organization_id = profile.get("active_organization_id")
            if active_organization_id is not None:
                resolved = active_organization_id
            elif memberships:
                resolved = memberships[0]["organization"]["id"]
            else:
                resolved = None
            set_resolved_default_org_id(resolved)

    async def _reauth(self) -> None:
        """Recover from a 401: refresh the access token, or re-login on failure."""
        async with self._auth_lock:
            if self._refresh is not None:
                try:
                    await self._refresh_access()
                    return
                except EpicStaffAPIError:
                    pass  # refresh rejected/expired — fall back to a full login
            await self._login()

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
            remediation = find_remediation(response.status_code, detail)
            raise EpicStaffAPIError(
                status_code=response.status_code,
                detail=detail,
                remediation=remediation,
            )

    async def _request(
        self,
        method: str,
        path: str,
        _skip_auth: bool = False,
        _skip_org: bool = False,
        **kwargs: Any,
    ) -> dict[str, Any]:
        if self._http is None:
            raise RuntimeError("Client not started — use async with EpicStaffClient()")

        # Auto-resolve a default active org before any authenticated, org-scoped
        # call. Skipped for login/refresh (_skip_auth) and for the /api/profile/
        # bootstrap call itself (_skip_org) to avoid recursion.
        if not _skip_auth and not _skip_org:
            await self._ensure_active_org()

        # BASIC mode: log in lazily and attach the JWT as a Bearer header. Skipped
        # for the login/refresh calls themselves (_skip_auth) to avoid recursion.
        # Caller-supplied headers win; login/refresh 401 handling is bypassed too.
        bearer_mode = not _skip_auth and self._settings.auth_mode == AuthMode.BASIC
        if bearer_mode:
            await self._ensure_auth()
            if self._access is not None:
                kwargs["headers"] = {
                    "Authorization": f"Bearer {self._access}",
                    **kwargs.get("headers", {}),
                }

        # httpx derives the Host header from base_url per-request, overriding client-level headers.
        # Docker service names with underscores (e.g. django_app) fail Django's RFC 1034/1035
        # hostname validation even when ALLOWED_HOSTS = ["*"]. Inject Host: localhost only when
        # the hostname contains underscores (Docker-only issue; no-op on real server hostnames).
        from urllib.parse import urlparse

        _hostname = urlparse(self._settings.base_url).hostname or ""
        if "_" in _hostname:
            kwargs["headers"] = {"Host": "localhost", **kwargs.get("headers", {})}

        # Org-scoped RBAC: the backend resolves the active org from X-Organization-Id.
        # Skipped for login/refresh and for the /api/profile/ bootstrap call itself —
        # neither is org-scoped, and the bootstrap call must not send a header derived
        # from its own not-yet-resolved result.
        if not (_skip_auth or _skip_org):
            org = get_active_org_id()
            if org is not None:
                kwargs["headers"] = {
                    "X-Organization-Id": str(org),
                    **kwargs.get("headers", {}),
                }

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

                # BASIC mode: a 401 means the access token expired. Refresh (or
                # re-login) and retry the request once with the new Bearer token.
                if bearer_mode and response.status_code == 401:
                    await self._reauth()
                    kwargs["headers"] = {
                        **kwargs.get("headers", {}),
                        "Authorization": f"Bearer {self._access}",
                    }
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
