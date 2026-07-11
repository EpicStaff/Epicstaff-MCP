"""Task-spec model for the flow-correctness eval harness.

A spec is a declarative description of one eval case: a flow fixture to grade
and the grade we expect `validate_flow` (via the pure `_validate_graph` seam)
to produce for it. See `evals/README.md` for the full format and examples.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class EvalSpec(BaseModel):
    """One eval case, loaded from a JSON file under `evals/specs/`."""

    model_config = ConfigDict(frozen=True)

    id: str
    title: str
    category: str
    fixture: str
    should_pass: bool
    expected_codes: list[str] = Field(default_factory=list)
    # "offline" grades a static fixture with zero network I/O (the default,
    # CI-friendly mode). "online" is the extension point in `evals/online.py`
    # — fetches a live graph_id instead of reading `fixture` — and is not
    # implemented yet.
    mode: Literal["offline", "online"] = "offline"
    graph_id: int | None = None
    notes: str | None = None

    @model_validator(mode="after")
    def _validate_shape(self) -> EvalSpec:
        if not self.should_pass and not self.expected_codes:
            raise ValueError(
                f"spec '{self.id}': expected_codes is required when should_pass is false"
            )
        if self.mode == "online" and self.graph_id is None:
            raise ValueError(f"spec '{self.id}': mode 'online' requires graph_id")
        if self.mode == "offline" and not self.fixture:
            raise ValueError(
                f"spec '{self.id}': mode 'offline' requires a fixture path"
            )
        return self

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> EvalSpec:
        return cls.model_validate(data)
