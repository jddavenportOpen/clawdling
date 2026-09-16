"""Background worker runs: dispatch, isolation, outcome, reaping.

Every test runs against a FAKE claude binary generated into tmp_path, never the
real one, so the suite costs nothing and needs no credentials. Each fake bakes
its behaviour into the file it is written to (rather than reading an env var),
so a test never has to mutate the process environment to pick a mode, and every
invocation appends what it saw - argv, cwd, whether BRIDGE_SECRET survived -
to a sidecar file the test can then assert on.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from bridge.config import Config
from bridge.main import create_app
from bridge.workers import (
    STATUS_DONE,
    STATUS_FAILED,
    STATUS_KILLED,
    STATUS_RUNNING,
    STATUS_TIMEOUT,
    WorkerConfig,
    WorkerLimitError,
    WorkerManager,
    build_dispatch_prompt,
    build_worker_argv,
    classify_outcome,
    read_result_frame,
)

from .conftest import TEST_SECRET, make_token, process_alive, wait_for

# ── the fake claude ──────────────────────────────────────────────────────────

_FAKE_TEMPLATE = '''#!{python}
"""A stand-in for the claude CLI. Emits stream-json, then exits."""
import json
import os
import sys
import time

MODE = {mode!r}

with open(os.path.realpath(__file__) + ".calls.jsonl", "a") as fh:
    fh.write(
        json.dumps(
            {{
                "argv": sys.argv[1:],
                "cwd": os.getcwd(),
                "saw_bridge_secret": "BRIDGE_SECRET" in os.environ,
                "run_id_env": os.environ.get("CLAWDLING_WORKER_RUN_ID"),
                "user_env": os.environ.get("CLAWDLING_WORKER_USER"),
            }}
        )
        + "\\n"
    )


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\\n")
    sys.stdout.flush()


emit({{"type": "system", "subtype": "init", "tools": ["Read"]}})

if MODE == "sleep":
    time.sleep(120)
    sys.exit(0)

emit({{"type": "assistant", "message": {{"role": "assistant", "content": "working"}}}})

if MODE == "crash":
    sys.stderr.write("fake stderr: the tool blew up\\n")
    sys.stderr.flush()
    sys.exit(3)

if MODE == "quiet":
    sys.exit(0)

emit(
    {{
        "type": "result",
        "subtype": "error_during_execution" if MODE == "error" else "success",
        "is_error": MODE == "error",
        "num_turns": 2,
        "result": "could not finish" if MODE == "error" else "objective complete",
    }}
)
sys.exit(0)
'''


def make_fake(tmp_path: Path, mode: str) -> Path:
    """Write a fake claude binary whose behaviour is baked into the file."""
    path = tmp_path / f"fake-claude-{mode}"
    path.write_text(_FAKE_TEMPLATE.format(python=sys.executable, mode=mode))
    path.chmod(0o755)
    return path


def calls_for(fake: Path) -> list[dict]:
    sidecar = Path(str(fake) + ".calls.jsonl")
    if not sidecar.is_file():
        return []
    return [json.loads(line) for line in sidecar.read_text().splitlines() if line.strip()]


# ── fixtures ─────────────────────────────────────────────────────────────────


@pytest.fixture
def worker_config(tmp_path: Path) -> WorkerConfig:
    return WorkerConfig(
        root=(tmp_path / "worker-state").resolve(),
        max_workers=2,
        default_runtime_sec=30,
    )


def build_client(config: Config, worker_config: WorkerConfig) -> TestClient:
    app = create_app(config, worker_config)
    client = TestClient(app)
    client.app_ref = app  # type: ignore[attr-defined]
    return client


@pytest.fixture
def wclient(workspace: Path, worker_config: WorkerConfig, tmp_path: Path):
    """A client whose claude binary is the well-behaved fake."""
    fake = make_fake(tmp_path, "ok")
    config = Config(
        secret=TEST_SECRET,
        workspace_root=workspace,
        max_sessions=4,
        scrollback_bytes=8 * 1024,
        claude_bin=str(fake),
        repo_root=Path(__file__).resolve().parents[2],
        profile="starter",
    )
    with build_client(config, worker_config) as client:
        client.fake = fake  # type: ignore[attr-defined]
        yield client


@pytest.fixture
def auth_headers() -> dict:
    return {"Authorization": f"Bearer {make_token()}"}


def client_with_mode(
    workspace: Path, worker_config: WorkerConfig, tmp_path: Path, mode: str
) -> TestClient:
    fake = make_fake(tmp_path, mode)
    config = Config(
        secret=TEST_SECRET,
        workspace_root=workspace,
        max_sessions=4,
        claude_bin=str(fake),
        repo_root=Path(__file__).resolve().parents[2],
        profile="starter",
    )
    client = build_client(config, worker_config)
    client.fake = fake  # type: ignore[attr-defined]
    return client


def git(cwd: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [
            "git",
            "-c",
            "user.email=worker@example.invalid",
            "-c",
            "user.name=worker",
            "-c",
            "commit.gpgsign=false",
            "-C",
            str(cwd),
            *args,
        ],
        capture_output=True,
        text=True,
        check=False,
    )


@pytest.fixture
def git_project(workspace: Path) -> Path:
    """A real (tiny) git repo inside the workspace root."""
    repo = workspace / "project-a"
    repo.mkdir(parents=True, exist_ok=True)
    (repo / "README.md").write_text("a repo\n")
    assert git(repo, "init", "--quiet").returncode == 0
    assert git(repo, "add", "README.md").returncode == 0
    assert git(repo, "commit", "--quiet", "-m", "first").returncode == 0
    return repo


def dispatch(client: TestClient, headers: dict, **body) -> dict:
    body.setdefault("objective", "tidy the notes directory")
    resp = client.post("/api/workers", json=body, headers=headers)
    assert resp.status_code == 201, resp.text
    return resp.json()


def run_of(client: TestClient, run_id: str):
    return client.app_ref.state.workers.get(run_id)


def finished(client: TestClient, run_id: str) -> bool:
    run = run_of(client, run_id)
    return run is not None and run.finished


# ── pure helpers ─────────────────────────────────────────────────────────────


def test_worker_argv_is_headless_and_carries_the_run_id():
    argv = build_worker_argv(claude_bin="claude", run_id="run-1", prompt="do it")
    assert argv[0] == "claude"
    assert argv[1:3] == ["--session-id", "run-1"]
    assert "-p" in argv
    assert argv[argv.index("--output-format") + 1] == "stream-json"
    assert "--verbose" in argv
    # The objective is the trailing positional, exactly like the session path.
    assert argv[-1] == "do it"


def test_worker_argv_carries_model_and_prompt_file():
    argv = build_worker_argv(
        claude_bin="claude",
        run_id="run-1",
        prompt="do it",
        model="claude-test-model",
        prompt_file=Path("/tmp/agent.md"),
        permission_mode="acceptEdits",
    )
    assert argv[argv.index("--model") + 1] == "claude-test-model"
    assert argv[argv.index("--append-system-prompt-file") + 1] == "/tmp/agent.md"
    assert argv[argv.index("--permission-mode") + 1] == "acceptEdits"


def test_dispatch_prompt_points_the_agent_at_its_workplan():
    prompt = build_dispatch_prompt("ship the thing", Path("/w/WORKPLAN.md"), "run-1")
    assert prompt.startswith("ship the thing")
    assert "WORKPLAN.md" in prompt
    assert "run-1" in prompt


def test_classify_outcome_prefers_the_result_frame_over_a_zero_exit():
    status, detail = classify_outcome(
        exit_code=0, result={"is_error": True, "subtype": "max_turns"}, killed=False, timed_out=False
    )
    assert status == STATUS_FAILED
    assert "max_turns" in detail


def test_classify_outcome_says_when_the_verdict_came_from_the_exit_code_alone():
    status, detail = classify_outcome(exit_code=0, result=None, killed=False, timed_out=False)
    assert status == STATUS_DONE
    assert "no result frame" in detail


def test_classify_outcome_kill_and_timeout_beat_everything():
    assert classify_outcome(exit_code=0, result=None, killed=True, timed_out=False)[0] == STATUS_KILLED
    assert classify_outcome(exit_code=0, result=None, killed=False, timed_out=True)[0] == STATUS_TIMEOUT


def test_read_result_frame_skips_junk_and_finds_the_last_result(tmp_path: Path):
    events = tmp_path / "events.jsonl"
    events.write_text(
        "\n".join(
            [
                "not json at all",
                json.dumps({"type": "assistant"}),
                json.dumps({"type": "result", "subtype": "success", "result": "done"}),
                "",
            ]
        )
    )
    frame = read_result_frame(events)
    assert frame is not None and frame["result"] == "done"


def test_read_result_frame_returns_none_when_there_is_no_frame(tmp_path: Path):
    events = tmp_path / "events.jsonl"
    events.write_text(json.dumps({"type": "assistant"}) + "\n")
    assert read_result_frame(events) is None
    assert read_result_frame(tmp_path / "missing.jsonl") is None


# ── dispatch ─────────────────────────────────────────────────────────────────


def test_dispatch_returns_the_run_shape(wclient, auth_headers, workspace):
    body = dispatch(wclient, auth_headers)
    assert body["status"] == STATUS_RUNNING
    assert len(body["run_id"]) == 36  # uuid4
    assert body["base_cwd"] == str(workspace)
    assert body["objective"] == "tidy the notes directory"
    assert body["exit_code"] is None
    for key in ("isolation", "isolated", "workplan", "max_runtime_sec", "elapsed_sec"):
        assert key in body


def test_dispatch_requires_auth(wclient):
    assert wclient.post("/api/workers", json={"objective": "x"}).status_code == 401
    assert wclient.get("/api/workers").status_code == 401


def test_dispatch_actually_starts_a_process(wclient, auth_headers):
    body = dispatch(wclient, auth_headers)
    assert body["pid"] is not None
    assert wait_for(lambda: finished(wclient, body["run_id"]), timeout=20)


def test_dispatch_rejects_an_empty_objective(wclient, auth_headers):
    assert wclient.post("/api/workers", json={"objective": ""}, headers=auth_headers).status_code == 422
    blank = wclient.post("/api/workers", json={"objective": "   "}, headers=auth_headers)
    assert blank.status_code == 400
    assert "objective" in blank.text


def test_dispatch_rejects_a_cwd_outside_the_workspace(wclient, auth_headers, outside_dir):
    resp = wclient.post(
        "/api/workers",
        json={"objective": "read the secrets", "cwd": str(outside_dir)},
        headers=auth_headers,
    )
    assert resp.status_code == 400
    assert "outside the allowed workspace roots" in resp.text


def test_dispatch_rejects_an_unknown_domain(wclient, auth_headers):
    resp = wclient.post(
        "/api/workers", json={"objective": "x", "domain": "nope"}, headers=auth_headers
    )
    assert resp.status_code == 400
    assert "unknown domain" in resp.text


def test_dispatch_rejects_a_bad_model_id(wclient, auth_headers):
    resp = wclient.post(
        "/api/workers",
        json={"objective": "x", "model": "bad model; rm -rf /"},
        headers=auth_headers,
    )
    assert resp.status_code == 400
    assert "invalid model id" in resp.text


def test_dispatch_rejects_an_unlisted_permission_mode(wclient, auth_headers):
    resp = wclient.post(
        "/api/workers",
        json={"objective": "x", "permission_mode": "bypassPermissions"},
        headers=auth_headers,
    )
    assert resp.status_code == 400
    assert "not allowed" in resp.text


def test_dispatch_rejects_a_runtime_over_the_ceiling(wclient, auth_headers):
    resp = wclient.post(
        "/api/workers",
        json={"objective": "x", "max_runtime_sec": 10**9},
        headers=auth_headers,
    )
    assert resp.status_code == 422


def test_dispatch_resolves_a_known_domain_to_its_agent_template(wclient, auth_headers):
    body = dispatch(wclient, auth_headers, domain="work")
    assert body["domain"] == "work"
    assert wait_for(lambda: finished(wclient, body["run_id"]), timeout=20)
    call = calls_for(wclient.fake)[-1]
    idx = call["argv"].index("--append-system-prompt-file")
    assert call["argv"][idx + 1].endswith("tasks.md")


def test_dispatch_enforces_the_concurrency_cap(workspace, worker_config, tmp_path, auth_headers):
    with client_with_mode(workspace, worker_config, tmp_path, "sleep") as client:
        for _ in range(worker_config.max_workers):
            dispatch(client, auth_headers)
        resp = client.post("/api/workers", json={"objective": "one too many"}, headers=auth_headers)
        assert resp.status_code == 429
        assert "worker limit reached" in resp.text


def test_the_cap_holds_when_dispatches_race(workspace, worker_config, tmp_path):
    """Two concurrent dispatches must not both win the last slot.

    The cap check and the fork are deliberately NOT under one lock - `git
    worktree add` can take seconds on a large repo and holding the lock would
    block every list call for that long - so the slot is RESERVED at check time
    and released only after the run is registered. Without that reservation this
    test starts max_workers + 2 children.
    """
    fake = make_fake(tmp_path, "sleep")
    manager = WorkerManager(config=worker_config, claude_bin=str(fake))
    real_prepare = manager.prepare_isolation

    def slow_prepare(base, run_id):
        time.sleep(0.3)  # widen the window between the cap check and registration
        return real_prepare(base, run_id)

    manager.prepare_isolation = slow_prepare  # type: ignore[method-assign]

    results: list[object] = []
    lock = threading.Lock()

    def go() -> None:
        try:
            run = manager.spawn(objective="race for the last slot", cwd=workspace)
        except WorkerLimitError:
            run = None
        with lock:
            results.append(run)

    threads = [threading.Thread(target=go) for _ in range(worker_config.max_workers + 2)]
    try:
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=60)
        started = [r for r in results if r is not None]
        assert len(started) == worker_config.max_workers
        assert manager.running_count() == worker_config.max_workers
    finally:
        manager.shutdown()


def test_the_child_never_inherits_the_bridge_secret(wclient, auth_headers, monkeypatch):
    monkeypatch.setenv("BRIDGE_SECRET", TEST_SECRET)
    body = dispatch(wclient, auth_headers)
    assert wait_for(lambda: finished(wclient, body["run_id"]), timeout=20)
    call = calls_for(wclient.fake)[-1]
    assert call["saw_bridge_secret"] is False
    assert call["run_id_env"] == body["run_id"]
    assert call["user_env"]  # the caller's identity is passed through


# ── isolation ────────────────────────────────────────────────────────────────


def test_a_git_repo_gets_its_own_worktree_and_branch(wclient, auth_headers, git_project):
    body = dispatch(wclient, auth_headers, cwd=str(git_project))
    assert body["isolation"] == "worktree"
    assert body["isolated"] is True
    assert body["branch"] == f"clawdling/worker-{body['run_id'][:8]}"
    worktree = Path(body["worktree"])
    assert worktree.is_dir()
    assert (worktree / "README.md").is_file()  # a real checkout, not an empty dir
    assert body["cwd"] == str(worktree)
    assert wait_for(lambda: finished(wclient, body["run_id"]), timeout=20)
    # The child really ran in the worktree, not in the shared checkout.
    assert Path(calls_for(wclient.fake)[-1]["cwd"]).resolve() == worktree.resolve()


def test_two_workers_on_one_repo_get_different_worktrees(wclient, auth_headers, git_project):
    a = dispatch(wclient, auth_headers, cwd=str(git_project))
    b = dispatch(wclient, auth_headers, cwd=str(git_project))
    assert a["worktree"] != b["worktree"]
    assert a["branch"] != b["branch"]
    assert Path(a["worktree"]).is_dir() and Path(b["worktree"]).is_dir()
    assert wait_for(lambda: finished(wclient, a["run_id"]) and finished(wclient, b["run_id"]), timeout=25)


def test_a_non_repo_records_that_isolation_was_unavailable(wclient, auth_headers, workspace):
    plain = workspace / "plain"
    plain.mkdir(exist_ok=True)
    body = dispatch(wclient, auth_headers, cwd=str(plain))
    assert body["isolation"] == "none"
    assert body["isolated"] is False
    assert body["worktree"] is None
    assert "not a git repository" in body["isolation_note"]
    # It still runs - it just runs where it was asked to, and says so.
    assert body["cwd"] == str(plain)


def test_the_workplan_carries_the_objective_and_the_run_id(wclient, auth_headers, git_project):
    body = dispatch(wclient, auth_headers, cwd=str(git_project), objective="rename the docs")
    plan = Path(body["workplan"])
    assert plan.is_file()
    text = plan.read_text()
    assert "rename the docs" in text
    assert body["run_id"] in text
    assert body["branch"] in text


def test_the_workplan_never_clobbers_an_existing_file(wclient, auth_headers, workspace):
    plain = workspace / "has-a-plan"
    plain.mkdir(exist_ok=True)
    existing = plain / "WORKPLAN.md"
    existing.write_text("the human's own plan\n")
    body = dispatch(wclient, auth_headers, cwd=str(plain))
    assert existing.read_text() == "the human's own plan\n"
    written = Path(body["workplan"])
    assert written.name == f"WORKPLAN-{body['run_id'][:8]}.md"
    assert written.is_file()


def test_a_subdirectory_spawn_lands_in_the_same_subdirectory_of_the_worktree(
    wclient, auth_headers, git_project
):
    sub = git_project / "services"
    sub.mkdir()
    (sub / "keep.txt").write_text("x\n")
    assert git(git_project, "add", "services/keep.txt").returncode == 0
    assert git(git_project, "commit", "--quiet", "-m", "sub").returncode == 0

    body = dispatch(wclient, auth_headers, cwd=str(sub))
    assert body["isolation"] == "worktree"
    assert Path(body["cwd"]) == Path(body["worktree"]) / "services"
    assert (Path(body["cwd"]) / "keep.txt").is_file()


# ── outcome ──────────────────────────────────────────────────────────────────


def test_a_clean_run_reaches_done_and_keeps_the_summary(wclient, auth_headers):
    body = dispatch(wclient, auth_headers)
    assert wait_for(lambda: finished(wclient, body["run_id"]), timeout=20)
    final = wclient.get(f"/api/workers/{body['run_id']}", headers=auth_headers).json()
    assert final["status"] == STATUS_DONE
    assert final["exit_code"] == 0
    assert final["summary"] == "objective complete"
    assert final["result_subtype"] == "success"
    assert final["num_turns"] == 2
    assert final["ended_at"]
    assert final["elapsed_sec"] > 0


def test_an_error_result_frame_is_failed_even_on_a_zero_exit(
    workspace, worker_config, tmp_path, auth_headers
):
    with client_with_mode(workspace, worker_config, tmp_path, "error") as client:
        body = dispatch(client, auth_headers)
        assert wait_for(lambda: finished(client, body["run_id"]), timeout=20)
        final = client.get(f"/api/workers/{body['run_id']}", headers=auth_headers).json()
        assert final["status"] == STATUS_FAILED
        assert final["exit_code"] == 0
        assert final["summary"] == "could not finish"


def test_a_nonzero_exit_is_failed(workspace, worker_config, tmp_path, auth_headers):
    with client_with_mode(workspace, worker_config, tmp_path, "crash") as client:
        body = dispatch(client, auth_headers)
        assert wait_for(lambda: finished(client, body["run_id"]), timeout=20)
        final = client.get(f"/api/workers/{body['run_id']}", headers=auth_headers).json()
        assert final["status"] == STATUS_FAILED
        assert final["exit_code"] == 3


def test_an_overstaying_run_is_reaped_as_timeout(
    workspace, worker_config, tmp_path, auth_headers
):
    with client_with_mode(workspace, worker_config, tmp_path, "sleep") as client:
        body = dispatch(client, auth_headers, max_runtime_sec=1)
        pid = body["pid"]
        assert wait_for(lambda: finished(client, body["run_id"]), timeout=30)
        final = client.get(f"/api/workers/{body['run_id']}", headers=auth_headers).json()
        assert final["status"] == STATUS_TIMEOUT
        assert "ceiling" in final["detail"]
        assert wait_for(lambda: not process_alive(pid), timeout=10)


# ── list / get ───────────────────────────────────────────────────────────────


def test_list_reports_every_run_and_the_cap(wclient, auth_headers, worker_config):
    first = dispatch(wclient, auth_headers)
    body = wclient.get("/api/workers", headers=auth_headers).json()
    assert body["max_workers"] == worker_config.max_workers
    assert [w["run_id"] for w in body["workers"]] == [first["run_id"]]


def test_get_unknown_run_is_a_404(wclient, auth_headers):
    assert wclient.get("/api/workers/nope", headers=auth_headers).status_code == 404


def test_health_reports_the_worker_counts(wclient):
    body = wclient.get("/api/health").json()
    assert body["workers"] == 0
    assert body["workers_running"] == 0
    assert body["max_workers"] == 2


# ── logs ─────────────────────────────────────────────────────────────────────


def test_log_tail_returns_the_event_lines(wclient, auth_headers):
    body = dispatch(wclient, auth_headers)
    assert wait_for(lambda: finished(wclient, body["run_id"]), timeout=20)
    log = wclient.get(f"/api/workers/{body['run_id']}/log", headers=auth_headers).json()
    assert log["stream"] == "events"
    assert log["lines"]
    frames = [json.loads(line) for line in log["lines"]]
    assert frames[0]["type"] == "system"
    assert frames[-1]["type"] == "result"


def test_log_tail_honours_the_line_count(wclient, auth_headers):
    body = dispatch(wclient, auth_headers)
    assert wait_for(lambda: finished(wclient, body["run_id"]), timeout=20)
    log = wclient.get(
        f"/api/workers/{body['run_id']}/log", params={"tail": 1}, headers=auth_headers
    ).json()
    assert len(log["lines"]) == 1
    assert json.loads(log["lines"][0])["type"] == "result"


def test_stderr_is_a_separate_stream_from_the_json_events(
    workspace, worker_config, tmp_path, auth_headers
):
    with client_with_mode(workspace, worker_config, tmp_path, "crash") as client:
        body = dispatch(client, auth_headers)
        assert wait_for(lambda: finished(client, body["run_id"]), timeout=20)
        events = client.get(f"/api/workers/{body['run_id']}/log", headers=auth_headers).json()
        stderr = client.get(
            f"/api/workers/{body['run_id']}/log",
            params={"stream": "stderr"},
            headers=auth_headers,
        ).json()
        # The stack trace must NOT be interleaved into the JSONL the outcome is
        # read from, or the events file stops being parseable.
        assert all(json.loads(line) for line in events["lines"])
        assert any("blew up" in line for line in stderr["lines"])


def test_log_rejects_an_unknown_stream(wclient, auth_headers):
    body = dispatch(wclient, auth_headers)
    resp = wclient.get(
        f"/api/workers/{body['run_id']}/log", params={"stream": "etc-passwd"}, headers=auth_headers
    )
    assert resp.status_code == 400


def test_log_follow_streams_lines_then_ends(wclient, auth_headers):
    body = dispatch(wclient, auth_headers)
    assert wait_for(lambda: finished(wclient, body["run_id"]), timeout=20)
    with wclient.stream(
        "GET",
        f"/api/workers/{body['run_id']}/log",
        params={"follow": "true"},
        headers=auth_headers,
    ) as resp:
        assert resp.status_code == 200
        text = "".join(resp.iter_text())
    assert "event: line" in text
    assert "event: end" in text
    assert STATUS_DONE in text
    # Exactly one terminal status frame plus the end frame - a client should not
    # have to de-duplicate identical frames.
    assert text.count("event: end") == 1
    assert text.count("event: status") <= 2


# ── kill ─────────────────────────────────────────────────────────────────────


def test_delete_kills_a_running_worker(workspace, worker_config, tmp_path, auth_headers):
    with client_with_mode(workspace, worker_config, tmp_path, "sleep") as client:
        body = dispatch(client, auth_headers)
        pid = body["pid"]
        assert process_alive(pid)
        killed = client.delete(f"/api/workers/{body['run_id']}", headers=auth_headers).json()
        assert killed["ok"] is True
        assert killed["status"] == STATUS_KILLED
        assert wait_for(lambda: not process_alive(pid), timeout=10)


def test_delete_is_idempotent_for_an_unknown_run(wclient, auth_headers):
    body = wclient.delete("/api/workers/never-existed", headers=auth_headers).json()
    assert body == {
        "ok": True,
        "run_id": "never-existed",
        "status": None,
        "exit_code": None,
        "reaped": False,
        "reap_refused": None,
    }


def test_delete_requires_auth(wclient):
    assert wclient.delete("/api/workers/anything").status_code == 401


def test_shutdown_terminates_running_workers(workspace, worker_config, tmp_path, auth_headers):
    client = client_with_mode(workspace, worker_config, tmp_path, "sleep")
    with client:
        body = dispatch(client, auth_headers)
        pid = body["pid"]
        assert process_alive(pid)
    # The lifespan shutdown ran when the context manager exited.
    assert wait_for(lambda: not process_alive(pid), timeout=10)


# ── reaping ──────────────────────────────────────────────────────────────────


def test_reap_removes_a_clean_worktree_and_its_branch(wclient, auth_headers, git_project):
    body = dispatch(wclient, auth_headers, cwd=str(git_project))
    assert wait_for(lambda: finished(wclient, body["run_id"]), timeout=20)
    worktree = Path(body["worktree"])
    assert worktree.is_dir()

    result = wclient.app_ref.state.workers.reap(body["run_id"])
    assert result.ok, result.reason
    assert not worktree.exists()
    branches = git(git_project, "branch", "--list", body["branch"]).stdout
    assert branches.strip() == ""


def test_reap_refuses_a_worktree_holding_unreachable_commits(wclient, auth_headers, git_project):
    body = dispatch(wclient, auth_headers, cwd=str(git_project))
    assert wait_for(lambda: finished(wclient, body["run_id"]), timeout=20)
    worktree = Path(body["worktree"])
    (worktree / "the-work.md").write_text("hours of it\n")
    assert git(worktree, "add", "the-work.md").returncode == 0
    assert git(worktree, "commit", "--quiet", "-m", "the work").returncode == 0

    result = wclient.app_ref.state.workers.reap(body["run_id"])
    assert result.ok is False
    assert "reachable from no other ref" in result.reason
    assert worktree.is_dir()  # nothing was deleted
    assert (worktree / "the-work.md").is_file()


def test_reap_allows_a_worktree_whose_commits_were_merged_away(
    wclient, auth_headers, git_project
):
    """The rule is reachability, not "made no commits".

    A worker that did real work and got it merged has nothing left to lose, so
    the reap must go through. This is also the regression test for writing the
    check as `rev-list HEAD --not --exclude=<ours> --all`: `--all` pretends HEAD
    is listed, and in this worktree HEAD IS our branch, so that spelling reports
    a worktree full of unmerged work as clean.
    """
    body = dispatch(wclient, auth_headers, cwd=str(git_project))
    assert wait_for(lambda: finished(wclient, body["run_id"]), timeout=20)
    worktree = Path(body["worktree"])
    (worktree / "the-work.md").write_text("hours of it\n")
    assert git(worktree, "add", "the-work.md").returncode == 0
    assert git(worktree, "commit", "--quiet", "-m", "the work").returncode == 0

    # Unmerged: refused.
    assert wclient.app_ref.state.workers.reap(body["run_id"]).ok is False

    assert git(git_project, "merge", "--quiet", "--no-edit", body["branch"]).returncode == 0

    result = wclient.app_ref.state.workers.reap(body["run_id"])
    assert result.ok, result.reason
    assert not worktree.exists()
    # The work survived the reap, in the base checkout.
    assert (git_project / "the-work.md").is_file()


def test_reap_refuses_a_dirty_worktree(wclient, auth_headers, git_project):
    body = dispatch(wclient, auth_headers, cwd=str(git_project))
    assert wait_for(lambda: finished(wclient, body["run_id"]), timeout=20)
    worktree = Path(body["worktree"])
    (worktree / "README.md").write_text("edited but never committed\n")

    result = wclient.app_ref.state.workers.reap(body["run_id"])
    assert result.ok is False
    assert "uncommitted" in result.reason
    assert worktree.is_dir()


def test_reap_refuses_while_the_run_is_still_going(
    workspace, worker_config, tmp_path, auth_headers, git_project
):
    with client_with_mode(workspace, worker_config, tmp_path, "sleep") as client:
        body = dispatch(client, auth_headers, cwd=str(git_project))
        result = client.app_ref.state.workers.reap(body["run_id"])
        assert result.ok is False
        assert "still going" in result.reason


def test_reap_never_deletes_outside_the_configured_worktree_root(
    wclient, auth_headers, git_project, tmp_path
):
    body = dispatch(wclient, auth_headers, cwd=str(git_project))
    assert wait_for(lambda: finished(wclient, body["run_id"]), timeout=20)

    decoy = tmp_path / "definitely-not-ours"
    decoy.mkdir()
    (decoy / "precious.txt").write_text("do not delete me\n")
    run = run_of(wclient, body["run_id"])
    run.worktree = decoy  # simulate a corrupted record

    result = wclient.app_ref.state.workers.reap(body["run_id"])
    assert result.ok is False
    assert "outside the configured worktree root" in result.reason
    assert (decoy / "precious.txt").is_file()


def test_delete_with_reap_reports_a_refusal_instead_of_swallowing_it(
    wclient, auth_headers, git_project
):
    body = dispatch(wclient, auth_headers, cwd=str(git_project))
    assert wait_for(lambda: finished(wclient, body["run_id"]), timeout=20)
    worktree = Path(body["worktree"])
    (worktree / "the-work.md").write_text("hours of it\n")
    assert git(worktree, "add", "the-work.md").returncode == 0
    assert git(worktree, "commit", "--quiet", "-m", "the work").returncode == 0

    resp = wclient.delete(
        f"/api/workers/{body['run_id']}", params={"reap": "true"}, headers=auth_headers
    ).json()
    assert resp["reaped"] is False
    assert "reachable from no other ref" in resp["reap_refused"]
    assert worktree.is_dir()


def test_delete_with_reap_removes_a_clean_worktree(wclient, auth_headers, git_project):
    body = dispatch(wclient, auth_headers, cwd=str(git_project))
    assert wait_for(lambda: finished(wclient, body["run_id"]), timeout=20)
    worktree = Path(body["worktree"])

    resp = wclient.delete(
        f"/api/workers/{body['run_id']}", params={"reap": "true"}, headers=auth_headers
    ).json()
    assert resp["reaped"] is True, resp
    assert not worktree.exists()


def test_reap_of_a_run_without_a_worktree_is_a_no_op(wclient, auth_headers, workspace):
    plain = workspace / "no-repo-here"
    plain.mkdir(exist_ok=True)
    body = dispatch(wclient, auth_headers, cwd=str(plain))
    assert wait_for(lambda: finished(wclient, body["run_id"]), timeout=20)
    result = wclient.app_ref.state.workers.reap(body["run_id"])
    assert result.ok is True
    assert "no worktree" in result.reason


def test_reap_of_an_unknown_run_is_refused(wclient):
    result = wclient.app_ref.state.workers.reap("never-existed")
    assert result.ok is False
    assert "unknown run" in result.reason


# ── no orphans ───────────────────────────────────────────────────────────────


def test_a_failed_spawn_does_not_leave_an_orphan_worktree(
    workspace, worker_config, tmp_path, auth_headers, git_project
):
    """If the binary cannot be exec'd, the worktree we just made must not survive."""
    config = Config(
        secret=TEST_SECRET,
        workspace_root=workspace,
        claude_bin=str(tmp_path / "does-not-exist"),
        repo_root=Path(__file__).resolve().parents[2],
        profile="starter",
    )
    with build_client(config, worker_config) as client:
        resp = client.post(
            "/api/workers",
            json={"objective": "x", "cwd": str(git_project)},
            headers=auth_headers,
        )
        assert resp.status_code == 500
        worktrees = worker_config.worktrees_dir
        leftovers = list(worktrees.iterdir()) if worktrees.is_dir() else []
        assert leftovers == []
        # ...and no branch was left behind either.
        assert "clawdling/worker" not in git(git_project, "branch", "--list").stdout


def test_worker_state_lives_under_the_configured_root(wclient, auth_headers, worker_config):
    body = dispatch(wclient, auth_headers)
    run = run_of(wclient, body["run_id"])
    assert worker_config.runs_dir in run.events_path.parents
    assert run.events_path.name == "events.jsonl"
    assert run.stderr_path.name == "stderr.log"
    assert os.path.isdir(worker_config.runs_dir)
