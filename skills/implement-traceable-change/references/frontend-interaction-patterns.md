# Frontend interaction patterns

## Async actions

Use one operation coordinator when multiple controls mutate the same resource. Disable or serialize
all conflicting actions, retain a stable in-flight promise for initial creation, and keep server
idempotency as the final protection.

## States

Implement normal, empty, loading, recoverable error, terminal error and permission-denied states
when applicable. Preserve user input after recoverable failures.

## Focus and dialogs

Move focus into a modal, contain tab order, make the background inert, close from inside the modal
with Escape, and restore focus. Test with a keyboard, not only DOM attributes.

## Server/client boundaries

Keep environment-only code out of client bundles. Verify hydration-sensitive values such as time,
randomness and locale. Do not assume a framework component boundary without reading project-local
framework guidance.
