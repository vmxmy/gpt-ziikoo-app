#!/usr/bin/env bash
# gpt-ziikoo-app's heavy gate checks, run by gate.sh from the unit worktree root.
# GATE_CHANGED = changed paths, one per line. Print "== <step>" before each step.
# Mirrors .github/workflows/ci.yml; the full run takes about 10 seconds, so tests run in full instead of `vitest related`.
# 本脚本在 agent-gate-heavy.flock 持有期间运行：不要在这里调用 gate.sh / gate.test.sh / orca-factory selftest，这类检查写进 spec 的 CHECK。
set -Eeuo pipefail

echo "== typecheck"      # two tsconfigs (worker, web); `cf workers types` regenerates .cloudflare/types first
pnpm typecheck

echo "== test"
pnpm test

echo "== build"
pnpm build

echo "== deploy-dry-run" # sends no API request and needs no credentials (docs/architecture.md「发布」)
pnpm exec cf deploy --dry-run --prebuilt --mode production
