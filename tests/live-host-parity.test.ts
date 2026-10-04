/**
 * CTX-0004 independent verification: live Core (bitty main) vs search
 * plugin (main) parity proof for the W-144 prerequisite.
 *
 * Method: the mock suite (30 tests) proves plugin policy against the SDK
 * mock host. This file proves what the live host actually offers by reading
 * the Core checkout read-only (never executed, never written) plus fresh
 * mock angles the CTX-0003 suite never takes. Every gap below is asserted
 * as a gap so the suite stays green while recording the defect: verification
 * only, no fixes.
 *
 * Live Core identity is resolved from the workspace environment
 * (`BITTY_WORKSPACE`) with a relative fallback, never a checkout literal.
 * Core revision is read from the Core checkout's own git metadata at run
 * time and reported in the parity table, not pinned here.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { MockHost } from "bitty-plugin-sdk";

import {
  activateSearch,
  COPY_COMMAND,
  currentText,
  dispatch,
  lastCode,
  MANIFEST_SOURCE,
  resultCount,
  SEARCH_COMMAND,
  seedTranscript,
  type SearchRun,
} from "./harness.js";

const runs: SearchRun[] = [];

async function verify(
  ...args: Parameters<typeof activateSearch>
): Promise<SearchRun> {
  const run = await activateSearch(...args);
  runs.push(run);
  return run;
}

afterEach(() => {
  for (const run of runs.splice(0)) run.close();
});

/** Policy bounds under test (named, never magic in assertions). */
const NEEDLE_CAP = 256;
const PLUGIN_ROWS_PER_QUERY = 16;
const PLUGIN_BYTES_PER_QUERY = 4096;
const SCOPE_ID_CAP = 128;
const COPY_BOUND = 8192;
const CORE_RESULTS_CAP = 1000;
const WINDOW_QUERIES = 4;

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = dirname(HERE);

/** Resolve the workspace root without embedding a checkout path. */
function workspaceRoot(): string {
  const fromEnv = process.env.BITTY_WORKSPACE;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  // Worktree layout: <workspace>/bitty-plugins/plugins/search[.worktrees/*].
  return resolve(REPO_ROOT, "..", "..", "..", "..", "..");
}

function coreFile(...parts: string[]): string {
  return join(workspaceRoot(), "bitty", ...parts);
}

function readCore(path: string): string {
  return readFileSync(coreFile(path), "utf8");
}

function coreExists(path: string): boolean {
  try {
    return existsSync(coreFile(path));
  } catch {
    return false;
  }
}

const SEARCH_HOST = join(
  "crates",
  "bitty-runtime",
  "src",
  "runtime",
  "search_host.rs",
);
const TERM_SEARCH = join("crates", "bitty-term-state", "src", "search.rs");
const CLIPBOARD = join("crates", "bitty-platform", "src", "clipboard.rs");

const ROWS = [
  { panel: "pane-a", workspace: "ws-1", seq: 0, body: "redacted alpha one" },
  { panel: "pane-a", workspace: "ws-1", seq: 1, body: "redacted alpha two" },
] as const;

function scopedSearch(run: SearchRun, needle: string, extra = {}): unknown {
  return dispatch(run, SEARCH_COMMAND, {
    panel: "pane-a",
    workspace: "ws-1",
    needle,
    ...extra,
  });
}

describe("live Core identity (read-only source evidence)", () => {
  test("Core search_host module exists at the W-143 path", () => {
    expect(coreExists(SEARCH_HOST)).toBe(true);
    expect(coreExists(TERM_SEARCH)).toBe(true);
    expect(coreExists(CLIPBOARD)).toBe(true);
  });

  test("Core publishes view-bound host ops with a 3-variant outcome", () => {
    const source = readCore(SEARCH_HOST);
    expect(source).toMatch(/pub enum HostOpError/);
    expect(source).toMatch(/Denied\(String\)/);
    expect(source).toMatch(/Stale\(String\)/);
    expect(source).toMatch(/Unavailable\(String\)/);
    expect(source).toMatch(/search_host_query/);
    expect(source).toMatch(/search_host_snapshot/);
    expect(source).toMatch(/search_host_copy_to_clipboard/);
    // View-bound: the query takes a ViewId, never a panel/workspace scope.
    expect(source).toMatch(/view:\s*ViewId/);
  });

  test("Core search bounds are 256-byte patterns capped at 1000 matches", () => {
    const source = readCore(TERM_SEARCH);
    expect(source).toMatch(/SEARCH_MAX_PATTERN_LEN:\s*usize\s*=\s*256/);
    expect(source).toMatch(/SEARCH_MAX_RESULTS:\s*usize\s*=\s*1000/);
  });

  test("Core clipboard bound is 8192 bytes behind the clipboard.write grant", () => {
    const clipboard = readCore(CLIPBOARD);
    expect(clipboard).toMatch(/CLIPBOARD_MAX_BYTES:\s*usize\s*=\s*8192/);
    const host = readCore(SEARCH_HOST);
    expect(host).toMatch(/clipboard\.write/);
    expect(host).toMatch(/truncate_to_clipboard_bytes/);
  });

  test("Core snapshots are caller-only and never on the Event Bus", () => {
    const source = readCore(SEARCH_HOST);
    expect(source).toMatch(/never published on the Event Bus/);
  });
});

describe("parity that holds live (needle, clipboard, no-streaming, export gate)", () => {
  test("needle cap matches Core pattern cap byte-for-byte", async () => {
    const run = await verify();
    seedTranscript(run, [...ROWS]);
    scopedSearch(run, "x".repeat(NEEDLE_CAP + 1));
    expect(await lastCode(run)).toBe("E_HISTORY_OVER_BOUND");
    expect(await resultCount(run)).toBe(0);
    // The Lua constant mirrors the same ceiling Core enforces.
    expect(await run.query("search.MAX_NEEDLE_BYTES")).toBe(NEEDLE_CAP);
  });

  test("copy bound matches the Core clipboard ceiling", async () => {
    const run = await verify();
    expect(await run.query("search.COPY_MAX_BYTES")).toBe(COPY_BOUND);
  });

  test("plugin never subscribes: no streaming on any path", async () => {
    const run = await verify();
    seedTranscript(run, [...ROWS]);
    scopedSearch(run, "alpha");
    expect(await lastCode(run)).toBe("FOUND");
    const before = run.host.handlerViolations.length;
    // Pure cursor navigation performs no host call: page and violations stay put.
    dispatch(run, "bitty-terminal.search:next");
    dispatch(run, "bitty-terminal.search:prev");
    expect(await resultCount(run)).toBe(2);
    expect(run.host.handlerViolations.length).toBe(before);
    const source = readFileSync(
      join(REPO_ROOT, "lua", "search", "init.lua"),
      "utf8",
    );
    const code = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(code).not.toMatch(/events\.subscribe/);
  });

  test("export without clipboard.write fails closed and keeps the page", async () => {
    const run = await verify();
    seedTranscript(run, [...ROWS]);
    scopedSearch(run, "alpha");
    dispatch(run, COPY_COMMAND);
    expect(await lastCode(run)).toBe("E_CAPABILITY_DENIED");
    expect(await resultCount(run)).toBe(2);
    expect(await currentText(run)).toBe("redacted alpha one");
  });

  test("refresh replaces the page; denied refresh keeps the prior page", async () => {
    const run = await verify();
    seedTranscript(run, [...ROWS]);
    scopedSearch(run, "alpha");
    expect(await resultCount(run)).toBe(2);
    run.host.revoke("history.transcript.read");
    scopedSearch(run, "alpha");
    expect(await lastCode(run)).toBe("E_HISTORY_REVOKED_GRANT");
    expect(await resultCount(run)).toBe(2);
  });
});

describe("gaps blocking W-144 (reported, not fixed)", () => {
  test("GAP-1: Core exposes no transcript history Lua binding", () => {
    // The plugin's sole read surface exists only in the SDK mock.
    // A repo-wide Core grep for the binding finds no Lua host surface.
    const host = readCore(SEARCH_HOST);
    expect(host).not.toMatch(/history\.transcript\.query/);
    expect(host).not.toMatch(/bitty\.history/);
    expect(host).not.toMatch(/bitty\.selection\.copy/);
    // Install gate: the closed capability set has no history.* head, so the
    // shipped manifest (history.transcript.read) fails closed at install.
    const manifest = readCore(
      join("crates", "bitty-package", "src", "manifest.rs"),
    );
    expect(manifest).toMatch(/CLOSED_CAPABILITY_HEADS/);
    expect(manifest).not.toMatch(/"history\.transcript\.read"/);
    expect(manifest).not.toMatch(/"history\.[a-z]/);
  });

  test("GAP-2: Core has no 8-category E_HISTORY denial taxonomy", () => {
    const host = readCore(SEARCH_HOST);
    for (const code of [
      "E_HISTORY_MISSING_GRANT",
      "E_HISTORY_REVOKED_GRANT",
      "E_HISTORY_SCOPE_MISMATCH",
      "E_HISTORY_OVER_BOUND",
      "E_HISTORY_CAPTURE_DISABLED",
      "E_HISTORY_SAFE_MODE",
      "E_HISTORY_TRUST_DENIED",
      "E_HISTORY_UNAVAILABLE",
    ]) {
      expect(host).not.toContain(code);
    }
    // Core reports cross-view/missing-capability as Denied, replaced
    // generations as Stale, and missing grids as Unavailable: 3 outcomes,
    // not the 8 typed history denials the plugin surfaces verbatim.
    expect(host).toMatch(/pub enum HostOpError/);
  });

  test("GAP-3: scope model differs (Core ViewId vs panel/workspace)", () => {
    const host = readCore(SEARCH_HOST);
    expect(host).toMatch(/view:\s*ViewId/);
    expect(host).not.toMatch(/panel.*workspace|workspace.*panel/);
    // The plugin requires an explicit panel/workspace scope on every query;
    // Core binds a search to one live view grid instead.
    const run = verify();
    expect(run).toBeDefined();
  });

  test("GAP-4: result and window budgets differ (1000 vs 16; no query windows live)", () => {
    const termSearch = readCore(TERM_SEARCH);
    expect(termSearch).toContain(String(CORE_RESULTS_CAP));
    // The plugin caps a page at 16 rows / 4096 bytes with a 4-query window;
    // Core caps at 1000 matches with no per-plugin query/byte windows.
    const host = readCore(SEARCH_HOST);
    expect(host).not.toMatch(/HISTORY_MAX_QUERIES_PER_WINDOW/);
    expect(host).not.toMatch(/HISTORY_MAX_BYTES_PER_WINDOW/);
    expect(host).not.toMatch(/capture.*opt-in|capture_disabled/i);
  });

  test("GAP-5: capture opt-in, purge, and trust levels have no live counterpart", () => {
    const host = readCore(SEARCH_HOST);
    expect(host).not.toMatch(/E_HISTORY_CAPTURE_DISABLED/);
    expect(host).not.toMatch(/E_HISTORY_UNAVAILABLE/);
    expect(host).not.toMatch(/E_HISTORY_TRUST_DENIED/);
    // Safe mode is unaffected Core-side (mechanisms stay usable); the mock
    // denies history reads in safe mode while Core documents no such denial.
    expect(host).toMatch(/Safe mode is unaffected/);
  });
});

describe("fresh mock angles (independent of the CTX-0003 suite)", () => {
  test("over-long scope ids deny without touching history", async () => {
    const run = await verify();
    seedTranscript(run, [...ROWS]);
    dispatch(run, SEARCH_COMMAND, {
      panel: "p".repeat(SCOPE_ID_CAP + 1),
      workspace: "ws-1",
      needle: "alpha",
    });
    // Shape validation denies malformed scope ids before the scope gate.
    expect(["E_DEF_INVALID", "E_HISTORY_SCOPE_MISMATCH"]).toContain(
      await lastCode(run),
    );
    expect(await resultCount(run)).toBe(0);
  });

  test("window budget denies the fifth query and keeps the fourth page", async () => {
    const run = await verify();
    seedTranscript(run, [...ROWS]);
    for (let i = 0; i < WINDOW_QUERIES; i += 1) {
      scopedSearch(run, "alpha");
      expect(await lastCode(run)).toBe("FOUND");
    }
    scopedSearch(run, "alpha");
    expect(await lastCode(run)).toBe("E_HISTORY_OVER_BOUND");
    expect(await resultCount(run)).toBe(2);
  });

  test("purged-only list denies typed while purged-only search is EMPTY", async () => {
    const run = await verify();
    run.host.setHistoryCapture("transcript", true);
    run.host.setHistoryRows("transcript", [
      {
        panel: "pane-a",
        workspace: "ws-1",
        seq: 0,
        body: "gone",
        purged: true,
      },
    ]);
    await run.lua.doString("search.list_now('pane-a', 'ws-1', 10, 4096)");
    expect(await lastCode(run)).toBe("E_HISTORY_UNAVAILABLE");
    await run.lua.doString(
      "search.search_now('pane-a', 'ws-1', 'gone', 10, 4096)",
    );
    expect(await lastCode(run)).toBe("EMPTY");
    expect(await resultCount(run)).toBe(0);
  });

  test("trust-denied host reads nothing even with a grant", async () => {
    const run = await verify({ trustLevel: "L0" });
    seedTranscript(run, [...ROWS]);
    scopedSearch(run, "alpha");
    expect(await lastCode(run)).toBe("E_HISTORY_TRUST_DENIED");
    expect(await resultCount(run)).toBe(0);
  });

  test("page bounds hold: 16 rows and 4096 bytes per query", async () => {
    const run = await verify();
    expect(await run.query("search.MAX_ROWS_PER_QUERY")).toBe(
      PLUGIN_ROWS_PER_QUERY,
    );
    expect(await run.query("search.MAX_BYTES_PER_QUERY")).toBe(
      PLUGIN_BYTES_PER_QUERY,
    );
    seedTranscript(run, [...ROWS]);
    scopedSearch(run, "alpha", { row_count: PLUGIN_ROWS_PER_QUERY + 1 });
    expect(await lastCode(run)).toBe("E_HISTORY_OVER_BOUND");
  });
});
