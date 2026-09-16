"""Profile and domain resolution.

A "domain" is a row in `profiles/<profile>/domains.yaml` (the same file
src/config/domains.ts reads, so the cockpit picker and the bridge cannot
disagree about what exists). When a row names an `agent:` prompt template, the
bridge passes it to the CLI as `--append-system-prompt-file <abs path>`.

The profile comes from ADJUTANT_PROFILE, defaulting to `starter`, which is the
same variable the Next.js half already uses.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import yaml

from .config import Config


class DomainError(ValueError):
    """Raised when a domain id or its agent template cannot be resolved."""


@dataclass(frozen=True)
class DomainSpec:
    id: str
    label: str
    agent_prompt: Path | None


def load_domains(config: Config) -> list[dict]:
    """Parse the active profile's domains.yaml. Returns [] when absent."""
    path = config.profile_dir / "domains.yaml"
    if not path.is_file():
        return []
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as exc:
        raise DomainError(f"{path} is not valid YAML: {exc}") from exc
    rows = data.get("domains") if isinstance(data, dict) else None
    if not isinstance(rows, list):
        return []
    return [r for r in rows if isinstance(r, dict) and r.get("id")]


def resolve_agent_prompt(ref: str, config: Config) -> Path:
    """Resolve an agent template reference to an absolute file inside the profile.

    `ref` is what domains.yaml carries, e.g. "agents/tasks.md". A bare name
    ("tasks" or "tasks.md") is also accepted so the spawn body's `agent` field
    is pleasant to use. The resolved path must stay inside the profile
    directory: domains.yaml is user-editable, so `agents/../../../etc/passwd`
    has to be refused here rather than trusted.
    """
    text = str(ref).strip()
    if not text:
        raise DomainError("agent template reference is empty")

    profile_dir = config.profile_dir.resolve()
    candidates: list[Path] = []
    if "/" in text:
        candidates.append(profile_dir / text)
    else:
        name = text if text.endswith(".md") else f"{text}.md"
        candidates.append(profile_dir / "agents" / name)
    if not text.endswith(".md"):
        candidates.append(profile_dir / f"{text}.md")

    for candidate in candidates:
        resolved = candidate.resolve()
        if not (resolved == profile_dir or profile_dir in resolved.parents):
            raise DomainError(
                f"agent template {text!r} resolves outside the profile directory"
            )
        if resolved.is_file():
            return resolved

    raise DomainError(
        f"agent template {text!r} not found under {profile_dir / 'agents'}"
    )


def resolve_domain(domain_id: str, config: Config) -> DomainSpec:
    """Look a domain up by id. Raises DomainError (a 400) when unknown."""
    wanted = str(domain_id).strip()
    rows = load_domains(config)
    if not rows:
        raise DomainError(
            f"no domains are defined in {config.profile_dir / 'domains.yaml'} "
            f"(profile {config.profile!r}); cannot resolve domain {wanted!r}"
        )

    for row in rows:
        if str(row.get("id", "")).strip() == wanted:
            agent_ref = row.get("agent")
            prompt = resolve_agent_prompt(agent_ref, config) if agent_ref else None
            return DomainSpec(
                id=wanted,
                label=str(row.get("label") or wanted),
                agent_prompt=prompt,
            )

    known = ", ".join(str(r.get("id")) for r in rows)
    raise DomainError(f"unknown domain {wanted!r}. Known domains: {known}")
