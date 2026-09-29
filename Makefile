# Clawdling — self-host make targets.
# (ADJUTANT_ env-var names are internal engine config and are intentionally kept.)
.PHONY: install run dev build start test typecheck leak-scan bridge bridge-install bridge-test docker-build docker-run clean

# The bridge runs on Python. Prefer a local .venv if one exists.
PYTHON ?= $(shell [ -x .venv/bin/python ] && echo .venv/bin/python || echo python3)

## install: one-time setup (node check, .env, deps, state dir)
install:
	./install.sh

## run: start the dev cockpit at http://localhost:3000 (the primary self-host path).
## Listens on 127.0.0.1 only. Single-user mode has no login, so anyone who can
## reach this port can drive your panes, and panes run commands on this machine.
## `CLAWDLING_HOST=0.0.0.0 make run` opens it to your network: read
## docs/REMOTE-ACCESS.md (tunnel + access lock) before you do.
run:
	npm run dev -- --hostname $${CLAWDLING_HOST:-127.0.0.1}

## dev: alias for run
dev: run

## build: production build -> .next/standalone.
## If it crashes on /_global-error, you have NODE_ENV=development set; use
## `env -u NODE_ENV make build`. See docs/KNOWN-ISSUES.md.
build:
	npm run build

## start: run the production build (after `make build`; see build note above).
## 127.0.0.1 only, like `run`; CLAWDLING_HOST overrides.
start:
	npm start -- --hostname $${CLAWDLING_HOST:-127.0.0.1}

## test: run the unit/component test suite (vitest)
test:
	npm run test

## typecheck: TypeScript type check (tsc --noEmit)
typecheck:
	npm run typecheck

## domain: create a domain agent -> `make domain ID=health LABEL=Health`
## Writes the profile row + an agent prompt template. No rebuild needed.
domain:
	@test -n "$(ID)" || (echo 'usage: make domain ID=<slug> [LABEL="..."] [BLURB="..."]' && exit 2)
	node scripts/add-domain.mjs --id "$(ID)" $(if $(LABEL),--label "$(LABEL)",) $(if $(BLURB),--blurb "$(BLURB)",) $(if $(COLOR),--color "$(COLOR)",)

## leak-scan: run the OSS personal-data leak gate locally
leak-scan:
	bash scripts/oss-leak-gate.sh

## bridge-install: create .venv and install the Python bridge dependencies.
## Needs Python 3.10+. macOS ships 3.9, which cannot import the bridge, so this
## picks the first python3 / python3.13..3.10 that qualifies and says so if none do.
bridge-install:
	@ok='import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'; py=''; \
	for c in python3 python3.13 python3.12 python3.11 python3.10; do \
	  if command -v $$c >/dev/null 2>&1 && $$c -c "$$ok" 2>/dev/null; then py=$$c; break; fi; \
	done; \
	if [ -z "$$py" ]; then \
	  echo "The bridge needs Python 3.10 or newer; found $$(python3 --version 2>&1)." >&2; \
	  echo "On a Mac: brew install python@3.12, then run make bridge-install again." >&2; exit 1; \
	fi; \
	if [ -x .venv/bin/python ] && ! .venv/bin/python -c "$$ok" 2>/dev/null; then \
	  echo "Replacing .venv (it was built on a Python older than 3.10)."; rm -rf .venv; \
	fi; \
	echo "Using $$py ($$($$py --version 2>&1))"; \
	$$py -m venv .venv && .venv/bin/pip install -q --upgrade pip && .venv/bin/pip install -q -r bridge/requirements.txt

## bridge: run the PTY bridge on 127.0.0.1, on the port in BRIDGE_URL (8787).
## Reads BRIDGE_SECRET and the CLAWDLING_* knobs from .env, the same file the
## cockpit reads, so the two always agree. Run `make bridge-install` once first.
bridge:
	@PYTHON="$(PYTHON)" bash scripts/run-bridge.sh

## bridge-test: run the bridge's pytest suite (never invokes the real claude CLI)
bridge-test:
	$(PYTHON) -m pytest bridge/tests -q

## docker-build: build the production container image
docker-build:
	docker build -t clawdling .

## docker-run: build + run the container (BYOK) on http://localhost:3000
docker-run: docker-build
	docker run --rm -e ANTHROPIC_API_KEY=$${ANTHROPIC_API_KEY} -p 3000:3000 -v clawdling-data:/data clawdling

## clean: remove local state + build artifacts (keeps .env)
clean:
	rm -rf .adjutant .next
