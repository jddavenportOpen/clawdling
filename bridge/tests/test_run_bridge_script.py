"""scripts/run-bridge.sh: the bridge takes its own knobs from .env, and nothing else.

`make bridge` runs this script. It loads BRIDGE_*, CLAWDLING_* and
ADJUTANT_PROFILE from the same .env the cockpit reads, so the shared secret
lives in one place. Everything else in .env must stay out: the bridge hands its
environment to every `claude` pane, and Claude Code prefers ANTHROPIC_API_KEY
over the user's subscription login. The first version of this script loaded the
whole file, and a fresh install's panes started failing with "401 The API Key
appears to be invalid" (with a real key they would instead have billed the API
account without saying so).

The script is exercised for real, with a stand-in `python` that records the
environment and argv it was exec'd with.
"""

from __future__ import annotations

import shutil
import subprocess
import textwrap
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "run-bridge.sh"
SECRET = "a" * 64


def _run(tmp_path: Path, env_file: str, shell_env: dict | None = None):
    root = tmp_path / "repo"
    (root / "scripts").mkdir(parents=True)
    shutil.copy(SCRIPT, root / "scripts" / "run-bridge.sh")
    (root / ".env").write_text(env_file)
    out = tmp_path / "exec.txt"
    fake = tmp_path / "fakepy"
    fake.write_text(
        textwrap.dedent(
            f"""\
            #!/bin/sh
            # `-c <probe>` is the dependency check; `-m uvicorn ...` is the launch.
            [ "$1" = "-c" ] && exit 0
            env > "{out}"
            echo "ARGV $*" >> "{out}"
            """
        )
    )
    fake.chmod(0o755)
    env = {"PATH": "/usr/bin:/bin", "HOME": str(tmp_path), "PYTHON": str(fake)}
    env.update(shell_env or {})
    proc = subprocess.run(
        ["bash", str(root / "scripts" / "run-bridge.sh")],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    if not out.exists():
        return proc, {}, []
    lines = out.read_text().splitlines()
    seen = dict(line.split("=", 1) for line in lines if "=" in line and not line.startswith("ARGV "))
    argv = next(line for line in lines if line.startswith("ARGV ")).split()[1:]
    return proc, seen, argv


def test_loads_the_bridge_knobs_and_nothing_else(tmp_path):
    proc, seen, argv = _run(
        tmp_path,
        "ANTHROPIC_API_KEY=sk-ant-api03-must-not-reach-a-pane\n"
        "ANTHROPIC_BASE_URL=https://example.invalid\n"
        "NEXTAUTH_SECRET=also-not-for-panes\n"
        "ADJUTANT_PROFILE=starter\n"
        f"BRIDGE_SECRET={SECRET}\n"
        "BRIDGE_URL=http://localhost:8917\n"
        "CLAWDLING_WORKSPACE_ROOT=~/ws\n",
    )
    assert proc.returncode == 0, proc.stderr
    assert seen["BRIDGE_SECRET"] == SECRET
    assert seen["ADJUTANT_PROFILE"] == "starter"
    assert seen["CLAWDLING_WORKSPACE_ROOT"] == f"{tmp_path}/ws"  # ~ expanded
    for leaked in ("ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "NEXTAUTH_SECRET"):
        assert leaked not in seen, f"{leaked} reached the bridge (and so every pane)"
    # The listen port follows BRIDGE_URL, the address the cockpit dials.
    assert argv[:2] == ["-m", "uvicorn"]
    assert argv[argv.index("--port") + 1] == "8917"
    assert argv[argv.index("--host") + 1] == "127.0.0.1"


def test_the_shell_wins_over_env_file(tmp_path):
    proc, seen, argv = _run(
        tmp_path,
        f"BRIDGE_SECRET={SECRET}\nBRIDGE_URL=http://localhost:8917\n",
        {"BRIDGE_PORT": "9999", "BRIDGE_SECRET": "b" * 64},
    )
    assert proc.returncode == 0, proc.stderr
    assert seen["BRIDGE_SECRET"] == "b" * 64
    assert argv[argv.index("--port") + 1] == "9999"


def test_an_empty_duplicate_never_clobbers_a_real_value(tmp_path):
    # Old .env files carry the bridge block twice; the later copy is empty.
    proc, seen, _ = _run(tmp_path, f"BRIDGE_SECRET={SECRET}\nBRIDGE_SECRET=\n")
    assert proc.returncode == 0, proc.stderr
    assert seen["BRIDGE_SECRET"] == SECRET


def test_default_port_when_bridge_url_has_none(tmp_path):
    proc, _, argv = _run(tmp_path, f"BRIDGE_SECRET={SECRET}\nBRIDGE_URL=https://bridge.example.com\n")
    assert proc.returncode == 0, proc.stderr
    assert argv[argv.index("--port") + 1] == "8787"


def test_refuses_to_start_without_a_secret(tmp_path):
    proc, seen, _ = _run(tmp_path, "BRIDGE_URL=http://localhost:8787\n")
    assert proc.returncode == 1
    assert "BRIDGE_SECRET is empty" in proc.stderr
    assert seen == {}  # never exec'd
