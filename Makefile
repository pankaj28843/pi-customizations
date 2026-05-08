SHELL := /usr/bin/env bash
.DEFAULT_GOAL := check

PI_CODING_AGENT_DIR ?= $(HOME)/.pi/agent
PI_CUSTOMIZATIONS_EXTENSION_NAME ?= pi-customizations

.PHONY: install uninstall verify-install check typecheck test clean smoke

install:
	pnpm install --frozen-lockfile
	pnpm check
	PI_CODING_AGENT_DIR="$(PI_CODING_AGENT_DIR)" PI_CUSTOMIZATIONS_EXTENSION_NAME="$(PI_CUSTOMIZATIONS_EXTENSION_NAME)" ./scripts/install.sh

uninstall:
	PI_CODING_AGENT_DIR="$(PI_CODING_AGENT_DIR)" PI_CUSTOMIZATIONS_EXTENSION_NAME="$(PI_CUSTOMIZATIONS_EXTENSION_NAME)" ./scripts/uninstall.sh

verify-install:
	test -L "$(PI_CODING_AGENT_DIR)/extensions/$(PI_CUSTOMIZATIONS_EXTENSION_NAME)"
	test "$$(readlink -f "$(PI_CODING_AGENT_DIR)/extensions/$(PI_CUSTOMIZATIONS_EXTENSION_NAME)")" = "$$(pwd)"
	@echo "pi-customizations is installed in $(PI_CODING_AGENT_DIR)/extensions/$(PI_CUSTOMIZATIONS_EXTENSION_NAME)"

check:
	pnpm check

typecheck:
	pnpm typecheck

test:
	pnpm test

smoke:
	pi --offline --no-session --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --no-builtin-tools -e ./index.ts --list-models openai >/dev/null
	@echo "pi loaded ./index.ts successfully"

clean:
	rm -rf node_modules dist coverage *.tsbuildinfo
