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
    """

    def __init__(self, status_code: int, detail: str) -> None:
        self.status_code = status_code
        self.detail = detail
        super().__init__(f"EpicStaff API error {status_code}: {detail}")


class EpicStaffNotFoundError(EpicStaffAPIError):
    """Raised on HTTP 404 responses."""

    def __init__(self, detail: str) -> None:
        super().__init__(status_code=404, detail=detail)
