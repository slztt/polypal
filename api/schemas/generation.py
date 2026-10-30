from typing import Any, Literal, Optional
from pydantic import BaseModel, Field


class JobStatus(BaseModel):
    job_id: str
    status: Literal["pending", "running", "done", "error", "cancelled"]
    progress: int = 0              # 0–100
    step: Optional[str] = None    # Human-readable current step
    output_url: Optional[str] = None
    error: Optional[str] = None
    priority: Optional[str] = None          # high | normal | low
    queue_position: Optional[int] = None    # 1 = next to start (pending jobs only)


class GenerateFromArtifactRequest(BaseModel):
    """Generic typed-artifact request. Only scene is public in this release."""
    input_kind: Literal["scene"]
    input_path: str
    model_id: str
    collection: str = "Workflows"
    params: dict[str, Any] = Field(default_factory=dict)
