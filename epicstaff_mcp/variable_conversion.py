"""Convert a JSON-Schema ``args_schema`` into the EpicStaff ``variables`` list.

The Django ``PythonCodeToolSerializer`` stores a Python tool's argument
definitions in a ``variables`` list (each entry an ``agent_input`` field), and
derives the CrewAI ``args_schema`` from it at runtime. It does NOT accept an
``args_schema`` field on write. Callers of the MCP think in JSON Schema, so this
module bridges the two — a faithful mirror of the backend's own
``src/shared/models/variable_conversion.py`` so a round-trip is lossless.
"""
from __future__ import annotations

from typing import Any

_PASSTHROUGH_TYPES = {"string", "number", "boolean", "object", "array", "any"}


def _normalize_type(json_type: Any) -> str:
    # JSON Schema `type` may be a list for nullable fields, e.g. ["number", "null"].
    if isinstance(json_type, list):
        json_type = next((t for t in json_type if t != "null"), None)

    if not json_type:
        return "string"

    if json_type == "integer":
        return "number"

    return json_type if json_type in _PASSTHROUGH_TYPES else json_type


def json_schema_node_to_nested_variable(node: dict) -> dict:
    normalized_type = _normalize_type(node.get("type"))

    result: dict[str, Any] = {
        "type": normalized_type,
        "description": node.get("description", ""),
        "default_value": node.get("default", None),
    }

    if normalized_type == "object":
        result["properties"] = {
            key: json_schema_node_to_nested_variable(value)
            for key, value in node.get("properties", {}).items()
        }
        result["required_properties"] = node.get("required", [])

    if normalized_type == "array":
        result["item"] = json_schema_node_to_nested_variable(node.get("items", {}))

    return result


def args_schema_to_variables(
    args_schema: dict, input_type: str = "agent_input"
) -> list[dict]:
    """Flatten a JSON-Schema object into EpicStaff ``variables`` entries.

    Only the top-level ``properties`` become variables; ``required`` marks which
    are mandatory. Nested object/array shapes are preserved on each variable.
    """
    required_names = set(args_schema.get("required", []))
    variables: list[dict] = []

    for name, prop in args_schema.get("properties", {}).items():
        variable = {
            "name": name,
            "input_type": input_type,
            "required": name in required_names,
        }
        variable.update(json_schema_node_to_nested_variable(prop))
        variables.append(variable)

    return variables
