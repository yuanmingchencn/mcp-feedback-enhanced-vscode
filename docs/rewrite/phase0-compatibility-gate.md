# Phase 0 Compatibility Gate

## Purpose

- Freeze externally visible behavior before rewrite internals begin.
- Fail fast when protocol or hook behavior drifts.

## Gate Test Suites

- `tests/compatibility-baseline.test.js`
- `tests/compatibility-e2e-gate.test.js`
- `tests/mcp-tool-contract.test.js`

## Required Commands

- `npm run compile`
- `node --test --test-concurrency=1 tests/compatibility-baseline.test.js tests/compatibility-e2e-gate.test.js tests/mcp-tool-contract.test.js`

## Must-Stay-Compatible Surface

- WebSocket message schema contracts in `src/messageSchemas.ts`
- Pending delivery behavior through `scripts/hooks/consume-pending.js`
- MCP tool list and signatures in `mcp-server/src/index.ts`
- MCP `get_system_info` response shape (JSON text content)
- `/health` and `/pending` endpoint availability in the extension hub

## Rewrite Rule

- Do not merge rewrite internals if any gate test fails.
- Add new compatibility tests before introducing intentional behavior changes.
