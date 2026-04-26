# imghost — common dev / release tasks
#
# `make help` lists everything.

.DEFAULT_GOAL := help

VERSION ?=
TAG ?=

.PHONY: help
help:  ## List available targets
	@awk 'BEGIN {FS = ":.*?## "} /^## ---/ {sub("^## ", ""); printf "\n\033[1m%s\033[0m\n", $$0; next} /^[a-zA-Z_-]+:.*?## / {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

## --- local development -----------------------------------------------------

.PHONY: install-deps
install-deps:  ## Install local dev tools (cargo-audit, cargo-deny)
	cargo install --locked cargo-audit cargo-deny

.PHONY: fmt
fmt:  ## Apply rustfmt
	cargo fmt --all

.PHONY: lint
lint:  ## fmt --check + clippy -D warnings
	cargo fmt --all -- --check
	cargo clippy --all-targets --locked -- -D warnings

.PHONY: test
test:  ## Run unit + integration tests
	cargo test --all-targets --locked

.PHONY: audit
audit:  ## cargo audit (advisory ignores in .cargo/audit.toml)
	cargo audit

.PHONY: deny
deny:  ## cargo deny check (policy in deny.toml)
	cargo deny check

.PHONY: ci
ci: lint test audit deny  ## Run everything CI runs (pre-push gate)

.PHONY: build
build:  ## Release build
	cargo build --release --locked

## --- container -------------------------------------------------------------

.PHONY: image
image:  ## Build runtime image locally
	docker build -t imghost:dev .

.PHONY: dev-up
dev-up:  ## Local: docker compose up -d --build
	docker compose up -d --build

.PHONY: dev-down
dev-down:  ## Local: docker compose down
	docker compose down

.PHONY: dev-logs
dev-logs:  ## Local: tail container logs
	docker compose logs -f imghost

## --- release ---------------------------------------------------------------

.PHONY: release
release:  ## Tag + push a release: make release VERSION=v0.1.0
	@if [ -z "$(VERSION)" ]; then echo "VERSION=vX.Y.Z required"; exit 1; fi
	@case "$(VERSION)" in v*.*.*) ;; *) echo "VERSION must look like v0.1.0"; exit 1 ;; esac
	@if ! git diff-index --quiet HEAD --; then echo "working tree dirty — commit first"; exit 1; fi
	git tag $(VERSION)
	git push origin $(VERSION)
	@echo "Tag pushed. Deploy workflow will fire — watch with: gh run watch"

.PHONY: rollback
rollback:  ## Re-deploy a prior tag: make rollback TAG=v0.0.9
	@if [ -z "$(TAG)" ]; then echo "TAG=vX.Y.Z required"; exit 1; fi
	gh workflow run deploy.yml -f tag=$(TAG)

## --- client ---------------------------------------------------------------

.PHONY: install-client
install-client:  ## Install the screenshot hotkey script (needs sudo)
	sudo install -m 0755 client/screenshot-upload.sh /usr/local/bin/imghost-screenshot
	@mkdir -p $(HOME)/.config/imghost
	@if [ ! -f $(HOME)/.config/imghost/env ]; then \
	  printf 'BASE_URL=https://aigf.dev\nTOKEN=\nCF_ACCESS_CLIENT_ID=\nCF_ACCESS_CLIENT_SECRET=\n' > $(HOME)/.config/imghost/env; \
	  chmod 600 $(HOME)/.config/imghost/env; \
	  echo "Wrote stub $(HOME)/.config/imghost/env (mode 600). Fill it in before use."; \
	fi
