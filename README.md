# Search

W-135 S-3 (CTX-0003) Lua policy package for Bitty scrollback search: bounded
snapshot queries over the public history API only. Accepted contracts are
W-135 (search-selection contract, bitty-terminal-docs `b0514e6`), W-131
(storage-and-history boundary, bitty-docs `21d63dc`), and W-137
(history-and-storage policy, bitty-plugins-docs `002c7ce`); the SDK binding
is bitty-plugin-sdk at `3ea8e58` (merged `main`; see the pin note below).
Core host evidence is W-143 (bitty `0d50b436`) plus the history-read host
(bitty `76fa42d6`).

## Overview

Search runs bounded, scoped snapshot queries over already-persisted transcript
history, then keeps one result page as presentation state for cursor
navigation. It never mutates Terminal Truth, never streams, and never retries
a denial silently: a failed refresh keeps the previous page intact. Record
bodies are untrusted observation text, displayed verbatim and never executed.

## Install

Prerequisites:

- Bitty `>=0.0.24` with Plugin API `^1.0` (the manifest `[compat]` minimum;
  no upper bound is declared).
- Opt-in capture enabled for transcript history. Without it, queries return
  `E_HISTORY_CAPTURE_DISABLED`.
- Consent to `history.transcript.read`. The plugin requests no clipboard,
  filesystem, process, network, overlay, or terminal authority.

Install from a local checkout:

```sh
git clone https://github.com/bitty-terminal/search.git
cd search
bitty plugin install "$PWD"
bitty plugin enable bitty-terminal.search
bitty plugin list
```

`bitty plugin install <path>` stages the package under the XDG data store and
records the capability you consent to; it executes no plugin code (`--yes`
approves non-interactively). Verify activation with `bitty plugin list`: the
entry must show `bitty-terminal.search`, version `0.0.1`, source `local-path`,
enabled, and the `history.transcript.read` grant.
`bitty plugin info bitty-terminal.search` prints the recorded grant set.

## Commands

Every command id is qualified with the plugin id. All commands return a table
with `ok` and `code`. None of the commands has a default keybinding.

| Command                        | What it does                                                                | Arguments                                                                                                                       | Default keybinding |
| ------------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `bitty-terminal.search:search` | Runs one bounded transcript search and replaces the cached page on success. | `panel`, `workspace` (at least one required), `needle` (1–256 bytes), `row_count` (integer 1–16), `max_bytes` (integer 1–4096). | None               |
| `bitty-terminal.search:next`   | Moves the cursor to the next cached match; no host call.                    | None                                                                                                                            | None               |
| `bitty-terminal.search:prev`   | Moves the cursor to the previous cached match; no host call.                | None                                                                                                                            | None               |
| `bitty-terminal.search:clear`  | Drops the cached result page.                                               | None                                                                                                                            | None               |
| `bitty-terminal.search:copy`   | Exports the current match through the clipboard gate.                       | None                                                                                                                            | None               |

`copy` fails closed with `E_CAPABILITY_DENIED` in this release: the manifest
declares no `clipboard.write` grant, and the history grant never implies
export. The command stays declared so a later grant can enable it under its
own review.

Below the table, `search` replaces the cached page only on success; a denial
keeps the prior page. `next` and `prev` clamp at the ends (`AT_LAST` and
`AT_FIRST`) and report `NO_RESULTS` when no page is cached. A query with no
`panel` or `workspace` is denied by the host with `E_HISTORY_SCOPE_MISMATCH`.

## Configuration

Settings live in `$XDG_CONFIG_HOME/bitty/plugins/bitty-terminal.search.lua`.
Values are read at activation and pinned to that plugin generation.

| Key         | Type  | Default | Description                                                                                                                               | Reload  |
| ----------- | ----- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `row_count` | `int` | `10`    | Rows per command query when the caller omits `row_count`. Accepted 1–16; an out-of-window configured value falls back to `10`.            | Restart |
| `max_bytes` | `int` | `4096`  | Byte budget per command query when the caller omits `max_bytes`. Accepted 1–4096; an out-of-window configured value falls back to `4096`. | Restart |

Example:

```lua
-- $XDG_CONFIG_HOME/bitty/plugins/bitty-terminal.search.lua
return {
  row_count = 10,
  max_bytes = 4096,
}
```

`Restart` means settings are resolved during activation: there is no settings
watcher or hot-reload path, so edit the file and restart Bitty. A denied
settings read does not abort activation; the plugin uses the documented
default and records one bounded `SETTINGS_DEGRADED` diagnostic. Configured
values never widen a query: explicit arguments still travel to the host,
which denies over-bound requests.

## Keybindings

Search registers no default keybindings. Bind a chord in
`$XDG_CONFIG_HOME/bitty/init.lua`:

```lua
return {
  keymaps = {
    {
      chord = "ctrl+n",
      action = "bitty-terminal.search:next",
      context = "global",
    },
  },
}
```

`next`, `prev`, and `clear` are safe to bind bare because they operate on the
cached page. `search` needs a `panel` or `workspace` argument (and a needle),
so invoke it through a caller that supplies them; a bare argument-free binding
denies with `E_HISTORY_SCOPE_MISMATCH`.

## Troubleshooting

| Code                         | Class        | Cause                                                                                                  | Remedy                                                                                                                                             |
| ---------------------------- | ------------ | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `E_SETTINGS_UNDECLARED`      | `validation` | A settings read named a key absent from the manifest `[settings]` declarations.                        | Install a plugin version whose declarations match the running build. Only `row_count` and `max_bytes` are declared.                                |
| `E_INCOMPATIBLE`             | `validation` | The running host does not satisfy `>=0.0.24`, or Plugin API is not `^1.0`.                             | Upgrade Bitty or install a Search release whose `[compat]` minimum covers your host.                                                               |
| `E_CAPABILITY_DENIED`        | `runtime`    | The transcript grant is missing, revoked, or expired, or `copy` ran without a `clipboard.write` grant. | Re-grant `history.transcript.read` and restart. For `copy`, this release intentionally has no clipboard grant; use the host's own copying instead. |
| `E_HISTORY_MISSING_GRANT`    | `runtime`    | No per-plugin transcript read grant is recorded (deny by default).                                     | Approve `history.transcript.read`.                                                                                                                 |
| `E_HISTORY_REVOKED_GRANT`    | `runtime`    | The grant existed but was revoked or expired after activation.                                         | Re-grant it and restart Bitty; a live generation keeps the grant bound at activation.                                                              |
| `E_HISTORY_SCOPE_MISMATCH`   | `runtime`    | `search` named no panel/workspace extent, or the grant does not cover the named scope.                 | Pass a `panel` or `workspace` inside the granted scope. A bare argument-free binding cannot search.                                                |
| `E_HISTORY_OVER_BOUND`       | `runtime`    | `row_count` exceeds 16, `max_bytes` exceeds 4096, or the needle is empty or longer than 256 bytes.     | Stay inside the caps. The plugin never clamps an explicit over-bound request.                                                                      |
| `E_HISTORY_CAPTURE_DISABLED` | `runtime`    | Opt-in transcript capture is off, so nothing was persisted to search.                                  | Enable transcript capture, then query again.                                                                                                       |
| `E_HISTORY_SAFE_MODE`        | `runtime`    | Bitty runs in safe mode, which reads no transcript history.                                            | Restart without safe mode to use Search.                                                                                                           |
| `E_HISTORY_TRUST_DENIED`     | `runtime`    | The caller's trust level or domain admits no standing access.                                          | Query from a trusted local context; unknown trust levels and domains deny rather than default.                                                     |
| `E_HISTORY_UNAVAILABLE`      | `runtime`    | The content was purged or expired, or the host has no transcript namespace.                            | Treat it as typed unavailability, not an empty result. The previous page is kept.                                                                  |

`E_DISABLED` means the activation-time compatibility gate rejected this
generation, and `NO_HOST` means the module was loaded without the host bridge
for tests or headless use; neither state exposes commands.

## Scope

- `bitty-plugin.toml`: plugin id `bitty-terminal.search`, version `0.0.1`,
  compat floor `bitty >=0.0.24` with `plugin-api ^1.0` and no upper bound,
  exactly one capability
  (`history.transcript.read`), declared `row_count`/`max_bytes` settings, lazy
  `search`/`next`/`prev`/`clear`/`copy` commands and no event subscriptions.
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
- `[settings]` declares exactly `row_count` (`int`, default 10) and
  `max_bytes` (`int`, default 4096): the only keys the entry point reads.
  Core denies an undeclared read with `E_SETTINGS_UNDECLARED`; the plugin reads
  each key behind `pcall`, degrades to the documented default, and records one
  bounded `SETTINGS_DEGRADED` diagnostic (192 bytes) instead of aborting
  activation or rendering an unexplained empty page.

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
mismatch. Host compatibility is minimum-only: `[compat].bitty` declares the
verified floor `>=0.0.24` and no ceiling, so newer hosts install without a
manifest edit. The plugin repeats the major-version gate at load as
defense in depth: on mismatch it records `disabled_reason` and registers
nothing for the generation.

## SDK pin note

`package.json` pins `bitty-plugin-sdk` to `3ea8e58f6e4da0ce8dcc2c8ade7fe348ec6c9ecb`,
a merged `main` commit. It carries the W-139 history/search/selection surface
(PR #144) plus the closed-set parity for `[settings]` declarations and the
mock-host declared-keys gate (PR #152). The linter accepts the `[settings]`
block and the harness denies undeclared reads with the same
`E_SETTINGS_UNDECLARED` code the Core host raises, so the activation regression
is reproducible locally. Derivation of every spelling and bound used here is
recorded in `docs/lua-defs.md` and `docs/mock-host.md` of the SDK.

## Development

Run the repository gates through the justfile:

```sh
just install
just check
```

`just check` includes `just docs-check`, which fails when the README
Configuration table omits a declared `[settings]` key, documents an undeclared
key, or drifts from the declared type or default.
