"""EpicStaff MCP Server — control EpicStaff via any MCP-compatible AI tool."""

from epicstaff_mcp.config import AuthMode, Settings, get_settings
from epicstaff_mcp.exceptions import (
    EpicStaffAPIError,
    EpicStaffConnectionError,
    EpicStaffError,
    EpicStaffNotFoundError,
)

__version__ = "0.1.0"

__all__ = [
    "__version__",
    "AuthMode",
    "EpicStaffAPIError",
    "EpicStaffConnectionError",
    "EpicStaffError",
    "EpicStaffNotFoundError",
    "Settings",
    "get_settings",
]
