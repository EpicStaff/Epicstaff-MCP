from __future__ import annotations


class EpicStaffError(Exception):
    """Base exception for all EpicStaff MCP errors."""


class EpicStaffConnectionError(EpicStaffError):
    """Raised when the EpicStaff server is unreachable or times out."""

    def __init__(self, message: str = "EpicStaff server is unreachable") -> None:
        super().__init__(message)


class EpicStaffAPIError(EpicStaffError):
    """Raised on HTTP 4xx/5xx responses from the EpicStaff API.

    Use EpicStaffNotFoundError for 404 responses.

    remediation: optional actionable next-step text. `client._raise_for_status`
    populates this for error signatures recognized by
    `epicstaff_mcp.error_remediation`; callers that raise this directly
    (pre-flight validation in tools/*.py) may also pass one.
    """

    def __init__(
        self, status_code: int, detail: str, remediation: str | None = None
    ) -> None:
        self.status_code = status_code
        self.detail = detail
        self.remediation = remediation
        message = f"EpicStaff API error {status_code}: {detail}"
        if remediation:
            message = f"{message}\nRemediation: {remediation}"
        super().__init__(message)


class EpicStaffNotFoundError(EpicStaffAPIError):
    """Raised on HTTP 404 responses."""

    def __init__(self, detail: str) -> None:
        super().__init__(status_code=404, detail=detail)
