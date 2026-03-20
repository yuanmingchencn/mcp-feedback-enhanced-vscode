# V3 Semantic Spec (Draft)

## Scope

- V3 prioritizes maintainability and clear runtime semantics over strict historical behavior parity.
- Tool names remain stable: `interactive_feedback`, `get_system_info`.
- Internal orchestration, error semantics, and state synchronization are allowed to change.

## Core Principles

- Single responsibility per module.
- Single source of truth per domain concept.
- Explicit runtime outcomes for success/failure paths.
- Compatibility gates protect only intentional external contract surface.

## Domain Semantics

### Feedback lifecycle

- `feedback_request` creates one pending feedback task in FIFO order.
- `feedback_response` resolves only the oldest pending task.
- `dismiss_feedback` resolves only the oldest pending task with a system marker.
- If no task exists, response/dismiss is treated as no-op and logged.

### Pending lifecycle

- Pending is independent from active feedback queue.
- Read and consume semantics are distinct:
  - read: non-destructive
  - consume: destructive and emits `pending_delivered`
- Consume is intended to be exactly-once from hook perspective.

### Reminder injection

- Reminder marker should have one authoritative append point in the feedback return pipeline.
- Other layers should pass through plain feedback text and avoid duplicate reminder mutations.

## Protocol Semantics

- Invalid inbound messages must be observable (log and explicit error event where applicable).
- `state_sync` represents authoritative snapshot from extension runtime state.
- Webview should treat unknown message types as safe no-op.

## Error Semantics

- Extension unavailable:
  - attempt local extension discovery
  - fallback path allowed (browser fallback)
  - return structured error when fallback fails
- Transport timeout and closed connection errors are explicit and surfaced to caller.

## Non-Goals

- Reintroducing tab or conversation_id based UI routing.
- Preserving duplicated legacy side effects if they conflict with semantic clarity.

## Validation Strategy

- Keep compile green.
- Keep Phase 0 gates green unless intentionally superseded by an approved semantic change.
- For every semantic change, add or update at least one black-box test proving the new rule.
