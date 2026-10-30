"""Turn a plain-English edit request into a validated list of mesh operations.

Two planners produce the same ``[{op, params}]`` shape:

* ``parse_instruction`` — deterministic phrase rules. Works offline, instantly,
  and is the fallback whenever no LLM is configured or the LLM answer is
  unusable.
* the LLM planner in ``routers/edit.py`` — handles free-form requests via a
  ``propose_edit_plan`` tool whose schema is generated from the registry.

Whatever the source, ``validate_plan`` is the gate: unknown operations are
rejected, unknown parameters dropped, and values coerced and clamped to the
operation's declared schema before anything touches a file.
"""

from __future__ import annotations

import re
from typing import Any, Iterable, Mapping, Optional

MAX_PLAN_STEPS = 12

UNIT_ALIASES = {
    "mm": "mm", "millimeter": "mm", "millimeters": "mm", "millimetre": "mm", "millimetres": "mm",
    "cm": "cm", "centimeter": "cm", "centimeters": "cm", "centimetre": "cm", "centimetres": "cm",
    "m": "m", "meter": "m", "meters": "m", "metre": "m", "metres": "m",
    "in": "in", "inch": "in", "inches": "in", '"': "in",
    "ft": "ft", "foot": "ft", "feet": "ft", "'": "ft",
}

_NUMBER = r"(\d+(?:[.,]\d+)?)"
_UNIT = r"(millimet(?:er|re)s?|centimet(?:er|re)s?|met(?:er|re)s?|inch(?:es)?|feet|foot|ft|mm|cm|in|m|\"|')"


class PlanError(ValueError):
    """The plan cannot be executed as written."""


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def _coerce(param: Mapping[str, Any], value: Any) -> Any:
    kind = param.get("type")
    if kind == "boolean":
        if isinstance(value, str):
            return value.strip().lower() in ("1", "true", "yes", "on")
        return bool(value)
    if kind == "select":
        allowed = [o["value"] for o in param.get("options", [])]
        text = str(value).strip().lower()
        for option in allowed:
            if str(option).lower() == text:
                return option
        raise PlanError(f"{param['id']} must be one of {', '.join(map(str, allowed))}")
    if kind in ("int", "float"):
        try:
            number = float(str(value).replace(",", ".")) if isinstance(value, str) else float(value)
        except (TypeError, ValueError) as exc:
            raise PlanError(f"{param['id']} must be a number") from exc
        if number != number or number in (float("inf"), float("-inf")):
            raise PlanError(f"{param['id']} must be finite")
        if param.get("min") is not None:
            number = max(float(param["min"]), number)
        if param.get("max") is not None:
            number = min(float(param["max"]), number)
        return int(round(number)) if kind == "int" else number
    return value


def validate_plan(
    steps: Iterable[Mapping[str, Any]],
    operations: Iterable[Mapping[str, Any]],
) -> tuple[list[dict[str, Any]], list[str]]:
    """Normalise ``steps`` against registry descriptions. Returns (steps, warnings)."""
    by_id = {op["id"]: op for op in operations}
    clean: list[dict[str, Any]] = []
    warnings: list[str] = []
    for index, raw in enumerate(steps):
        if not isinstance(raw, Mapping):
            raise PlanError(f"Step {index + 1} is not an object")
        op_id = str(raw.get("op") or raw.get("operation") or "").strip()
        if op_id not in by_id:
            raise PlanError(f"Step {index + 1}: unknown operation '{op_id}'")
        schema = {p["id"]: p for p in by_id[op_id].get("params_schema", [])}
        params_in = raw.get("params") or {}
        if not isinstance(params_in, Mapping):
            raise PlanError(f"Step {index + 1}: params must be an object")
        params: dict[str, Any] = {}
        for key, value in params_in.items():
            if key not in schema:
                warnings.append(f"Step {index + 1} ({op_id}): ignored unknown parameter '{key}'")
                continue
            params[key] = _coerce(schema[key], value)
        clean.append({"op": op_id, "label": by_id[op_id].get("label", op_id), "params": params})
    if not clean:
        raise PlanError("The plan has no steps")
    if len(clean) > MAX_PLAN_STEPS:
        raise PlanError(f"Plans are limited to {MAX_PLAN_STEPS} steps")
    return clean, warnings


# ---------------------------------------------------------------------------
# Deterministic phrase rules
# ---------------------------------------------------------------------------

def _number(text: str) -> float:
    return float(text.replace(",", "."))


def _count(text: str) -> Optional[int]:
    """'5k' / '5,000' / '12000' / '1.5m' → integer face count."""
    match = re.search(r"(\d+(?:[.,]\d+)*)\s*(k|thousand|m(?:illion)?)?\b", text)
    if not match:
        return None
    digits, suffix = match.group(1), (match.group(2) or "").lower()
    if suffix in ("k", "thousand"):
        return int(round(_number(digits) * 1000))
    if suffix.startswith("m"):
        return int(round(_number(digits) * 1_000_000))
    return int(digits.replace(",", "").split(".")[0])


def _axis(text: str, default: str) -> str:
    match = re.search(r"\b(?:around|about|on|along|across|over|in)?\s*(?:the\s*)?([xyz])(?:[- ]?axis)?\b", text)
    if match:
        return match.group(1)
    if re.search(r"horizontal|left[- ]right|sideways", text):
        return "x"
    if re.search(r"vertical|up[- ]?side|top[- ]bottom", text):
        return "y"
    if re.search(r"front[- ]back|depth", text):
        return "z"
    return default


def _intensity(text: str, low: int, mid: int, high: int) -> int:
    if re.search(r"\b(slight(ly)?|a (little|bit)|gentl[ey]|subtl[ey]|light(ly)?)\b", text):
        return low
    if re.search(r"\b(a lot|very|heav(y|ily)|strong(ly)?|much|really)\b", text):
        return high
    return mid


def _rule_decimate(clause: str, stats: Mapping[str, Any]) -> Optional[dict[str, Any]]:
    if not re.search(r"decimat|simplif|reduc|fewer (tri|poly|face)|low[- ]?poly|lower (the )?(poly|tri|face)|optimi[sz]e|lighter", clause):
        return None
    faces = int(stats.get("faces") or 0)
    percent = re.search(r"(\d+(?:\.\d+)?)\s*%", clause)
    target: Optional[int] = None
    if percent and faces:
        share = _number(percent.group(1)) / 100.0
        # "by 30%" removes 30%; "to 30%" keeps 30%.
        target = int(faces * (1 - share)) if re.search(r"\bby\b", clause) else int(faces * share)
    elif re.search(r"\bhalf\b", clause) and faces:
        target = faces // 2
    elif re.search(r"\b(quarter)\b", clause) and faces:
        target = faces // 4
    else:
        count = _count(clause)
        if count:
            target = count
    if target is None:
        target = max(1000, faces // 2) if faces else 10000
    return {"op": "decimate", "params": {"target_faces": target}}


def _rule_smooth(clause: str, _stats: Mapping[str, Any]) -> Optional[dict[str, Any]]:
    if not re.search(r"smooth|soften|less (bumpy|noisy|jagged|rough)|remove (noise|bumps)|polish", clause):
        return None
    passes = re.search(r"(\d+)\s*(times|iterations?|passes|x)\b", clause)
    iterations = int(passes.group(1)) if passes else _intensity(clause, 2, 5, 12)
    return {"op": "smooth", "params": {"iterations": iterations, "mode": "taubin"}}


def _rule_repair(clause: str, _stats: Mapping[str, Any]) -> Optional[dict[str, Any]]:
    if not re.search(r"repair|fill (the )?holes|close (the )?holes|watertight|manifold|fix (the )?(mesh|geometry|holes)|printable", clause):
        return None
    return {"op": "repair", "params": {}}


def _rule_components(clause: str, _stats: Mapping[str, Any]) -> Optional[dict[str, Any]]:
    keep_largest = bool(re.search(r"(only|just) (keep )?the (largest|biggest|main)|keep (only |just )?the (largest|biggest|main)", clause))
    if not keep_largest and not re.search(r"floater|floating|debris|stray|small (pieces|parts|bits|islands|components)|disconnected|loose (pieces|parts|bits)|islands", clause):
        return None
    return {"op": "remove_small_components", "params": {"keep_largest_only": keep_largest}}


def _rule_normals(clause: str, _stats: Mapping[str, Any]) -> Optional[dict[str, Any]]:
    if not re.search(r"normals?|inside[- ]out|flipped faces|black (patches|spots)|dark (patches|spots)|backface", clause):
        return None
    return {"op": "fix_normals", "params": {}}


def _rule_subdivide(clause: str, _stats: Mapping[str, Any]) -> Optional[dict[str, Any]]:
    if not re.search(r"subdivid|denser|more (polys|polygons|triangles|faces|density|resolution)|increase (the )?(density|resolution|poly)", clause):
        return None
    passes = re.search(r"(\d+)\s*(times|iterations?|levels?|x)\b", clause)
    smooth = bool(re.search(r"smooth|round|loop", clause))
    return {"op": "subdivide", "params": {"iterations": int(passes.group(1)) if passes else 1,
                                          "mode": "loop" if smooth else "midpoint"}}


def _rule_rotate(clause: str, _stats: Mapping[str, Any]) -> Optional[dict[str, Any]]:
    upside_down = re.search(r"upside[- ]down", clause)
    if not (re.search(r"\b(rotat|turn|spin|tilt)", clause) or upside_down):
        return None
    if upside_down and not re.search(r"\b(rotat|turn|spin)", clause):
        return {"op": "rotate", "params": {"axis": "x", "degrees": 180}}
    degrees: Optional[float] = None
    match = re.search(r"(-?\d+(?:\.\d+)?)\s*(°|deg(?:rees?)?)", clause)
    if match:
        degrees = _number(match.group(1))
    elif re.search(r"quarter", clause):
        degrees = 90
    elif re.search(r"half[- ]?(turn|way)|around|180|upside", clause):
        degrees = 180
    if degrees is None:
        bare = re.search(r"\b(-?\d+(?:\.\d+)?)\b", clause)
        degrees = _number(bare.group(1)) if bare else 90.0
    if re.search(r"\bclockwise\b", clause) and not re.search(r"counter|anti", clause):
        degrees = -abs(degrees)
    axis = "x" if re.search(r"\btilt|forward|backward", clause) else "y"
    return {"op": "rotate", "params": {"axis": _axis(clause, axis), "degrees": degrees}}


def _rule_mirror(clause: str, _stats: Mapping[str, Any]) -> Optional[dict[str, Any]]:
    if not re.search(r"\bmirror|\bflip\b|\breflect", clause) or re.search(r"flipped faces|normals?", clause):
        return None
    return {"op": "mirror", "params": {"axis": _axis(clause, "x")}}


def _rule_size(clause: str, _stats: Mapping[str, Any]) -> Optional[dict[str, Any]]:
    match = re.search(_NUMBER + r"\s*" + _UNIT + r"(?=\s|$|[.,;!?])\s*(tall|high|in height|wide|in width|long|deep|in depth|across)?", clause)
    if not match:
        return None
    unit = UNIT_ALIASES.get(match.group(2).lower())
    if unit is None:
        return None
    word = (match.group(3) or "").lower()
    context_words = clause
    if word in ("tall", "high", "in height") or re.search(r"\b(tall|height|high)\b", context_words):
        dimension = "height"
    elif word in ("wide", "in width") or re.search(r"\b(wide|width)\b", context_words):
        dimension = "width"
    elif word in ("deep", "in depth") or re.search(r"\b(deep|depth)\b", context_words):
        dimension = "depth"
    else:
        dimension = "longest"
    return {"op": "scale_to_size", "params": {"dimension": dimension, "size": _number(match.group(1)), "unit": unit}}


def _rule_scale(clause: str, _stats: Mapping[str, Any]) -> Optional[dict[str, Any]]:
    factor: Optional[float] = None
    match = re.search(r"(\d+(?:\.\d+)?)\s*(x|times)\b", clause)
    if match and re.search(r"scale|bigger|larger|smaller|size|big|large", clause):
        factor = _number(match.group(1))
        if re.search(r"smaller", clause) and factor > 1:
            factor = 1.0 / factor
    elif re.search(r"twice as (big|large)|double (the )?size", clause):
        factor = 2.0
    elif re.search(r"half (the|its) size|half as (big|large)", clause):
        factor = 0.5
    elif re.search(r"\b(bigger|larger|enlarge)\b", clause):
        factor = 1.5
    elif re.search(r"\b(smaller|shrink)\b", clause):
        factor = 2.0 / 3.0
    if factor is None:
        return None
    return {"op": "scale", "params": {"factor": factor}}


def _rule_recenter(clause: str, _stats: Mapping[str, Any]) -> Optional[dict[str, Any]]:
    if not re.search(r"cent(er|re)|origin|on the (ground|floor)|ground it|drop (it )?to the (ground|floor)", clause):
        return None
    return {"op": "recenter", "params": {}}


# Order matters only for tie-breaking inside one clause: the first match wins.
# Rotation/mirroring come before sizing so "rotate 45 in x" is not read as inches.
_RULES = (
    _rule_components, _rule_normals, _rule_repair, _rule_decimate, _rule_subdivide,
    _rule_smooth, _rule_rotate, _rule_mirror, _rule_size, _rule_scale, _rule_recenter,
)

# Commas between digits ("12,500", "1,5 m") are part of a number, not a break.
_SPLIT = re.compile(r"\s*(?:(?<!\d),|,(?!\d)|;|\bthen\b|\band then\b|\bafter that\b|\bfinally\b|\band\b|\balso\b|\.\s)\s*")


def parse_instruction(text: str, stats: Optional[Mapping[str, Any]] = None) -> list[dict[str, Any]]:
    """Plan steps for ``text`` using phrase rules (may return an empty list)."""
    stats = stats or {}
    lowered = text.strip().lower().replace("’", "'")
    steps: list[dict[str, Any]] = []
    for clause in filter(None, (c.strip() for c in _SPLIT.split(lowered))):
        for rule in _RULES:
            step = rule(clause, stats)
            if step is not None:
                steps.append(step)
                break
    return steps


# ---------------------------------------------------------------------------
# LLM planning
# ---------------------------------------------------------------------------

PLANNER_SYSTEM_PROMPT = """\
You are PolyPal's mesh-edit planner. Convert the user's request into an ordered
list of mesh operations by calling the propose_edit_plan tool exactly once.

Rules:
- Use ONLY the operations listed in the tool schema, with their exact ids.
- Only set parameters you need; omitted parameters use their defaults.
- Lengths are real-world: use scale_to_size with an explicit unit for sizes.
- Order matters: clean-up (remove_small_components, repair, fix_normals) before
  decimate/smooth, sizing and orientation last.
- If the request cannot be done with these operations, call the tool with an
  empty steps list and explain why in "summary".
"""


def planner_tool(operations: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """OpenAI-style tool definition generated from the registry."""
    ops = list(operations)
    catalogue = "\n".join(
        f"- {op['id']}: {op.get('description') or op.get('label')} params: "
        + ", ".join(
            f"{p['id']} ({p.get('type')}"
            + (f", {p.get('min')}..{p.get('max')}" if p.get("min") is not None else "")
            + (f", one of {[o['value'] for o in p.get('options', [])]}" if p.get("type") == "select" else "")
            + ")"
            for p in op.get("params_schema", [])
        )
        for op in ops
    )
    return {
        "type": "function",
        "function": {
            "name": "propose_edit_plan",
            "description": "Propose the ordered mesh operations that fulfil the request.\nOperations:\n" + catalogue,
            "parameters": {
                "type": "object",
                "properties": {
                    "summary": {"type": "string", "description": "One sentence describing the plan."},
                    "steps": {
                        "type": "array",
                        "maxItems": MAX_PLAN_STEPS,
                        "items": {
                            "type": "object",
                            "properties": {
                                "op": {"type": "string", "enum": [op["id"] for op in ops]},
                                "params": {"type": "object"},
                            },
                            "required": ["op"],
                        },
                    },
                },
                "required": ["steps"],
            },
        },
    }


def describe_mesh_for_prompt(stats: Mapping[str, Any]) -> str:
    if not stats:
        return "No mesh statistics available."
    extents = stats.get("extents") or [0, 0, 0]
    parts = [
        f"{stats.get('faces', 0):,} triangles, {stats.get('vertices', 0):,} vertices",
        "size (W×H×D, metres): " + " × ".join(f"{e:.3g}" for e in extents),
        f"{stats.get('components', '?')} connected piece(s)",
        "watertight" if stats.get("watertight") else f"open ({stats.get('boundary_edges', 0)} boundary edges)",
    ]
    if stats.get("units") == "m":
        parts.append("real-world size already set")
    return "Current mesh: " + "; ".join(parts) + "."


def summarise_plan(steps: Iterable[Mapping[str, Any]]) -> str:
    phrases = []
    for step in steps:
        params = step.get("params") or {}
        op = step.get("op")
        if op == "decimate":
            phrases.append(f"decimate to {int(params.get('target_faces', 0)):,} triangles")
        elif op == "smooth":
            phrases.append(f"smooth ({params.get('iterations', 5)} passes)")
        elif op == "scale_to_size":
            phrases.append(f"set {params.get('dimension', 'height')} to {params.get('size')} {params.get('unit')}")
        elif op == "rotate":
            phrases.append(f"rotate {params.get('degrees', 90):g}° about {str(params.get('axis', 'y')).upper()}")
        elif op == "mirror":
            phrases.append(f"mirror across {str(params.get('axis', 'x')).upper()}")
        elif op == "scale":
            phrases.append(f"scale ×{float(params.get('factor', 1)):.3g}")
        else:
            phrases.append(str(step.get("label") or op).lower())
    if not phrases:
        return "No changes."
    text = ", then ".join(phrases)
    return text[0].upper() + text[1:] + "."
