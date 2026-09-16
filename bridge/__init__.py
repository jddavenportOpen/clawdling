"""Clawdling cockpit bridge.

A small FastAPI service that runs real `claude` CLI processes inside PTYs and
exposes them to the Next.js cockpit over the wire contract pinned in
BRIDGE-CONTRACT.md at the repo root.

Run it with:  make bridge    (or: python -m bridge)
"""

__all__ = ["__version__"]

__version__ = "1.0.0"
