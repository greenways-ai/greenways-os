SHELL := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c

RESP_PORT ?= 7355
WS_PORT ?= 7356
PROFILE_DIR ?=
PLAYWRIGHT_INSTALL_FLAGS ?= --with-deps --no-shell

EXTENSION_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
DETECTED_WORKSPACE_ROOT := $(shell \
  directory="$(EXTENSION_DIR)"; \
  while [ "$$directory" != "/" ]; do \
    if [ -x "$$directory/technology/hara/scripts/runtime/build-hara-wasm-raw" ] \
       && [ -d "$$directory/application/greenways-os/extension/hara-chrome" ]; then \
      printf '%s' "$$directory"; \
      break; \
    fi; \
    directory="$$(dirname "$$directory")"; \
  done)
HARA_WORKSPACE_ROOT ?= $(DETECTED_WORKSPACE_ROOT)
HARA_DIR = $(HARA_WORKSPACE_ROOT)/technology/hara
HARA_BIN = $(HARA_DIR)/core/hara
HARA_BUILD = $(HARA_DIR)/scripts/runtime/build-hara-wasm-raw
HARA_RUN = "$(HARA_BIN)" --root "$(HARA_WORKSPACE_ROOT)" --allow-file --offline --no-color

.NOTPARALLEL:
.PHONY: help check-workspace dependencies browser build sync dev test test-sync test-browser

help:
	@printf '%s\n' \
	  'make build        build Hara WASM and stage extension assets' \
	  'make dev          install dependencies, build, and run headless Chromium' \
	  'make test         run Node protocol and bridge unit tests' \
	  'make test-sync    validate the native asset sync in fresh Hara processes' \
	  'make test-browser build and run the full Playwright extension suite' \
	  '' \
	  'Variables: RESP_PORT=7355 WS_PORT=7356 PROFILE_DIR= HARA_WORKSPACE_ROOT='

check-workspace:
	@if [ -z "$(HARA_WORKSPACE_ROOT)" ]; then \
	  echo 'Unable to detect the Greenways meta-workspace root.' >&2; \
	  echo 'Set HARA_WORKSPACE_ROOT to the directory containing application/ and technology/.' >&2; \
	  exit 2; \
	fi
	@test -x "$(HARA_BUILD)" || { echo "Missing canonical Hara WASM builder: $(HARA_BUILD)" >&2; exit 2; }
	@test -x "$(HARA_BIN)" || { echo "Missing Hara launcher: $(HARA_BIN)" >&2; exit 2; }
	@test -d "$(HARA_WORKSPACE_ROOT)/application/greenways-os/extension/hara-chrome" || { \
	  echo "HARA_WORKSPACE_ROOT does not contain application/greenways-os/extension/hara-chrome" >&2; \
	  exit 2; \
	}
	@test -f "$(EXTENSION_DIR)/ui/hara-ui/tokens.css" || { \
	  echo 'Missing ui/hara-ui checkout; initialise the hara-ui submodule/workspace dependency.' >&2; \
	  exit 2; \
	}

dependencies:
	@if [ ! -d node_modules ] || ! npm ls --silent >/dev/null 2>&1; then npm ci; fi

browser: dependencies
	npx playwright install $(PLAYWRIGHT_INSTALL_FLAGS) chromium

build: check-workspace
	"$(HARA_BUILD)" vm
	$(HARA_RUN) run "$(EXTENSION_DIR)/scripts/sync-runtime.hal"

sync: check-workspace
	$(HARA_RUN) run "$(EXTENSION_DIR)/scripts/sync-runtime.hal"

dev:
	$(MAKE) dependencies
	$(MAKE) browser
	$(MAKE) build
	RESP_PORT="$(RESP_PORT)" WS_PORT="$(WS_PORT)" PROFILE_DIR="$(PROFILE_DIR)" node scripts/dev-runtime.mjs

test: dependencies
	node --test test/*.test.js

test-sync: check-workspace
	"$(HARA_BUILD)" vm
	cat scripts/sync-runtime.hal | $(HARA_RUN) stdin
	$(HARA_RUN) run "$(EXTENSION_DIR)/scripts/sync-runtime.hal"
	$(HARA_RUN) run "$(EXTENSION_DIR)/test/sync-runtime-test.hal"

test-browser:
	$(MAKE) dependencies
	$(MAKE) browser
	$(MAKE) build
	npx playwright test
