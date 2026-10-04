# search

W-135 S-3 (CTX-0003) Lua policy package for Bitty scrollback search: bounded
snapshot queries over the public history API only. Accepted contracts are
W-135 (search-selection contract, bitty-terminal-docs `b0514e6`), W-131
(storage-and-history boundary, bitty-docs `21d63dc`), and W-137
(history-and-storage policy, bitty-plugins-docs `002c7ce`); the SDK binding
is bitty-plugin-sdk at `0a9487f` (PR #144 head, OPEN; see the pin note
below). Core host evidence is W-143 (bitty `0d50b436`) plus the history-read
host (bitty `76fa42d6`).

## Scope

- `bitty-plugin.toml`: plugin id `bitty-terminal.search`, version `0.0.1`,
  compat `bitty >=0.5,<1.0` with `plugin-api ^1.0`, exactly one capability
  (`history.transcript.read`), lazy `search`/`next`/`prev`/`clear`/`copy`
  commands and no event subscriptions.
- `lua/search/init.lua`: the whole policy. Snapshot query state (scope,
  needle, bounds, cached page, cursor) as presentation state that never
  mutates Terminal Truth; explicit-scope `search`/`list`/`tail` queries over
  `bitty.history.transcript.query`; pure cursor navigation over the cached
  page; grant-gated export through `bitty.selection.copy`. A refresh replaces
  the cached page; a denied query keeps the previous page intact.
- `tests/`: bun + wasmoon suite against the SDK `MockHost`, mirroring the
  composer harness pattern. Covers the snapshot search lifecycle (scoped
  finds, untrusted labels, navigation clamps, clear, replace-on-refresh,
  denied-refresh-keeps-page), the typed denial taxonomy (missing grant,
  revoked, scope mismatch, over-bound, capture off, safe mode, trust, purge),
  window budgets, mismatch disable with fallback, and denial parity against
  a foreign manifest plus the no-weakening proof.

## Rules

- Public API only. One additive v2 capability (`history.transcript.read`);
  no commands history, no KV, no clipboard, no filesystem, process-spawn,
  network, overlay, or terminal authority. Record bodies are untrusted
  observation text: displayed or copied verbatim, never executed or
  interpolated.
- Explicit scope on every query (panel and/or workspace, never `*`/`all`);
  explicit row/byte bounds; capture opt-in; typed host denials surface
  verbatim with the previous page kept. Nothing is truncated by the plugin,
  nothing is retried silently.
- Result export needs the separate `clipboard.write` grant and fails closed
  with `E_CAPABILITY_DENIED` without it; the history grant never implies it.
- No `bitty.terminal.*` reads, no event subscriptions, no streaming: a
  snapshot is point-in-time with no freshness promise, and fresh results
  require an explicit new query.
- Version/capability mismatch disables with a diagnostic and no partial
  activation: no commands exist for the generation.
- Bounds mirror the SDK/Core test caps: 256-byte needle, 16 rows / 4096 bytes
  per query, 128-byte scope ids, 8192-byte copy bound (host-enforced with a
  `truncated` flag). Shapes are normative; numbers are harness placeholders.

## Non-goals (CTX-0003 only)

- No Core changes, no host-API implementation, no SDK changes.
- No registry onboarding and no release; the package stays a candidate until
  CTX-0004 independently verifies stale-snapshot and input-lifecycle evidence
  plus Core W-144 parity.
- No live per-view search binding, viewport navigation, or selection
  lifecycles: those stay Core-owned deferred pending W-01 + W-138; the mock
  covers persisted history search plus the clipboard export only.

## Compat

The host validates `plugin-api ^1.0` before activation and fails closed on
mismatch. The plugin repeats the major-version gate at load as
defense in depth: on mismatch it records `disabled_reason` and registers
nothing for the generation.

## SDK pin note

`package.json` pins `bitty-plugin-sdk` to `0a9487f6c6f47ea0e3cadc9b710e7b1150485822`,
the head of PR #144 (CTX-0066, W-139 history/search/selection surface), which
is OPEN. The pin tracks that PR head rather than a merged release so the
`history.transcript.query` / `selection.copy` gate shapes, the
`history.transcript.read` head, and the 8-category denial taxonomy match the
reviewed surface byte-for-byte. Re-pin to the #144 merge commit when it
lands; derivation of every spelling and bound used here is recorded in
`docs/lua-defs.md` and `docs/mock-host.md` of that PR branch.
