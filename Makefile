# Clawdling — self-host make targets.
# (ADJUTANT_ env-var names are internal engine config and are intentionally kept.)
.PHONY: install run dev build start test typecheck leak-scan docker-build docker-run clean

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

## leak-scan: run the OSS personal-data leak gate locally
leak-scan:
	bash scripts/oss-leak-gate.sh

## docker-build: build the production container image
docker-build:
	docker build -t clawdling .

## docker-run: build + run the container (BYOK) on http://localhost:3000
docker-run: docker-build
	docker run --rm -e ANTHROPIC_API_KEY=$${ANTHROPIC_API_KEY} -p 3000:3000 -v clawdling-data:/data clawdling

## clean: remove local state + build artifacts (keeps .env)
clean:
	rm -rf .adjutant .next
