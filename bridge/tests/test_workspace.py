"""cwd containment: the one field that decides what a stranger can read."""

from __future__ import annotations

import dataclasses

import pytest

from bridge.workspace import WorkspaceError, resolve_cwd

from .conftest import spawn


def test_none_means_workspace_root(config):
    assert resolve_cwd(None, config) == config.workspace_root


def test_relative_path_resolves_under_the_root(config):
    assert resolve_cwd("project-a", config) == config.workspace_root / "project-a"


def test_absolute_path_inside_is_allowed(config):
    inside = config.workspace_root / "project-a"
    assert resolve_cwd(str(inside), config) == inside


def test_dotdot_traversal_is_rejected(config):
    with pytest.raises(WorkspaceError):
        resolve_cwd("project-a/../../../..", config)


def test_absolute_outside_is_rejected(config, outside_dir):
    with pytest.raises(WorkspaceError):
        resolve_cwd(str(outside_dir), config)


def test_etc_is_rejected(config):
    with pytest.raises(WorkspaceError):
        resolve_cwd("/etc", config)


def test_symlink_escape_is_rejected(config, outside_dir):
    """A symlink INSIDE the workspace that points out of it is still out."""
    link = config.workspace_root / "escape-hatch"
    link.symlink_to(outside_dir, target_is_directory=True)
    with pytest.raises(WorkspaceError):
        resolve_cwd(str(link), config)


def test_missing_directory_is_rejected(config):
    with pytest.raises(WorkspaceError):
        resolve_cwd("no-such-project", config)


def test_file_is_not_a_directory(config):
    f = config.workspace_root / "notes.txt"
    f.write_text("hi")
    with pytest.raises(WorkspaceError):
        resolve_cwd(str(f), config)


def test_null_byte_is_rejected(config):
    with pytest.raises(WorkspaceError):
        resolve_cwd("project-a\x00/etc", config)


def test_allowlisted_root_is_permitted(config, outside_dir):
    widened = dataclasses.replace(config, extra_roots=(outside_dir,))
    assert resolve_cwd(str(outside_dir), widened) == outside_dir


# ── wire ─────────────────────────────────────────────────────────────────────


def test_spawn_rejects_traversal_with_400(client, auth):
    resp = client.post(
        "/api/sessions/spawn",
        json={"cwd": "../../../../etc"},
        headers=auth,
    )
    assert resp.status_code == 400
    assert "outside the allowed workspace roots" in resp.json()["detail"]


def test_spawn_rejects_absolute_outside_with_400(client, auth, outside_dir):
    resp = client.post("/api/sessions/spawn", json={"cwd": str(outside_dir)}, headers=auth)
    assert resp.status_code == 400


def test_spawn_accepts_a_path_inside(client, auth, config):
    session = spawn(client, auth, cwd="project-a")
    assert session["cwd"] == str(config.workspace_root / "project-a")
