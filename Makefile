# Clawdling — self-host make targets.
# (ADJUTANT_ env-var names are internal engine config and are intentionally kept.)
.PHONY: install run dev build start test typecheck leak-scan bridge bridge-install bridge-test docker-build docker-run clean

# The bridge runs on Python. Prefer a local .venv if one exists.
PYTHON ?= $(shell [ -x .venv/bin/python ] && echo .venv/bin/python || echo python3)

## install: one-time setup (node check, .env, deps, state dir)
install:
	./install.sh

## run: start the dev cockpit at http://localhost:3000 (the primary self-host path)
run:
	npm run dev

## dev: alias for run
dev: run

## build: production build -> .next/standalone.
## If it crashes on /_global-error, you have NODE_ENV=development set; use
## `env -u NODE_ENV make build`. See docs/KNOWN-ISSUES.md.
build:
	npm run build

## start: run the production build (after `make build`; see build note above)
start:
	npm start

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

## bridge-install: create .venv and install the Python bridge dependencies
bridge-install:
	python3 -m venv .venv
	.venv/bin/pip install -q --upgrade pip
	.venv/bin/pip install -r bridge/requirements.txt

## bridge: run the PTY bridge on http://127.0.0.1:8787 (needs BRIDGE_SECRET set)
## Run `make bridge-install` once first. See bridge/README.md.
bridge:
	$(PYTHON) -m uvicorn bridge.main:app --host $${BRIDGE_HOST:-127.0.0.1} --port $${BRIDGE_PORT:-8787}

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
