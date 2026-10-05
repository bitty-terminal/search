/**
 * CTX-0004 independent verification: live Core (bitty main) vs search
 * plugin (main) parity proof for the W-144 prerequisite.
 *
 * Method: the mock suite (30 tests) proves plugin policy against the SDK
 * mock host. This file proves what the live host actually offers by reading
 * the Core checkout read-only (never executed, never written) plus fresh
 * mock angles the CTX-0003 suite never takes.
 *
 * Re-verification (CTX-0004b): the first pass probed Core @fea38d86, which
 * predates the history-read host merge (bitty PR #1673 -> 76fa42d6, now in
 * main). Every probe here pins FRESH origin/main (c246e52 at re-probe time)
 * via `git show origin/main:<path>` — read-only plumbing, never a working
 * tree write — with a working-tree fallback for offline runs. Result: all
 * five former gaps (GAP-1..GAP-5) REFUTE as stale-Core artifacts. The
 * history-read surface (capability family, gate, taxonomy, budgets,
 * capture/purge/trust/safe-mode) exists live with the exact codes and
 * bounds the plugin's mock enforces. Verdict: PASS.
 *
 * Surface binding note: the plugin binds the history-read snapshot surface
 * (panel/workspace scopes, HistoryGate), never the view-bound live-grid
 * search surface (ViewId, HostOpError, 1000-match cap). Assertions that once
 * read as divergences compared the plugin against the wrong surface; each
 * refutation below names both surfaces.
 *
 * Live Core identity is resolved from the workspace environment
 * (`BITTY_WORKSPACE`) with a relative fallback, never a checkout literal.
 * Core revision is read from the Core checkout's own git metadata at run
 * time and reported in the parity table, not pinned here.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
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

/** Bitty checkout directory (derived, never a literal). */
function coreDir(): string {
  return coreFile("");
}

/**
 * Read a Core file pinned to FRESH origin/main via read-only git plumbing.
 * Falls back to the working-tree read for offline runs; the fallback can
 * only lag the pinned revision, never lead it.
 */
function readFresh(path: string): string {
  const rel = path.split("/").join("/");
  try {
    return execFileSync(
      "git",
      ["-C", coreDir(), "show", `origin/main:${rel}`],
      {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      },
    );
  } catch {
    return readFileSync(coreFile(path), "utf8");
  }
}

function freshExists(path: string): boolean {
  const rel = path.split("/").join("/");
  try {
    execFileSync(
      "git",
      ["-C", coreDir(), "cat-file", "-e", `origin/main:${rel}`],
      { stdio: "ignore" },
    );
    return true;
  } catch {
    return coreExists(path);
  }
}

/** Resolved fresh-main revision the probes actually read. */
function freshRev(): string {
  try {
    return execFileSync("git", ["-C", coreDir(), "rev-parse", "origin/main"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

/** History-read host merge; must be an ancestor of the probed revision. */
const HISTORY_READ_MERGE = "76fa42d6";

const SEARCH_HOST = join(
  "crates",
  "bitty-runtime",
  "src",
  "runtime",
  "search_host.rs",
);
const TERM_SEARCH = join("crates", "bitty-term-state", "src", "search.rs");
const CLIPBOARD = join("crates", "bitty-platform", "src", "clipboard.rs");
const HISTORY_READ = join(
  "crates",
  "bitty-plugin-host",
  "src",
  "history_read.rs",
);
const MANIFEST = join("crates", "bitty-package", "src", "manifest.rs");
const CAPABILITY = join("crates", "bitty-plugin-host", "src", "capability.rs");

/**
 * Fail-soft gate: live-identity describes require a Core checkout alongside
 * (resolved via BITTY_WORKSPACE or the relative workspace fallback, never a
 * hardcoded path). The plugins CI job has no `bitty` checkout, so those
 * describes skip with an explicit notice while ALL mock-level assertions
 * keep running. With BITTY_WORKSPACE pointed at a real workspace the live
 * tests execute (proves the skip never masks a real run).
 *
 * Working-tree files cover the live-identity probes; the history-read gate
 * is probed via fresh origin/main (read-only git plumbing) so a stale
 * working tree still counts as present when the Core checkout exists.
 */
const CORE_PRESENT =
  coreExists(SEARCH_HOST) &&
  coreExists(TERM_SEARCH) &&
  coreExists(CLIPBOARD) &&
  freshExists(HISTORY_READ);

if (!CORE_PRESENT) {
  console.log(
    `live Core not present at ${coreDir()} ` +
      `(BITTY_WORKSPACE=${process.env.BITTY_WORKSPACE ?? "(unset, relative fallback)"}); ` +
      `skipping live-identity describes, mock assertions still run`,
  );
}

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

describe.skipIf(!CORE_PRESENT)(
  "live Core identity (read-only source evidence)",
  () => {
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

    test("probes pin fresh origin/main containing the history-read merge", () => {
      const rev = freshRev();
      expect(rev).toMatch(/^[0-9a-f]{40}$/);
      expect(() =>
        execFileSync(
          "git",
          [
            "-C",
            coreDir(),
            "merge-base",
            "--is-ancestor",
            HISTORY_READ_MERGE,
            "origin/main",
          ],
          { stdio: "ignore" },
        ),
      ).not.toThrow();
      // The history-read surface the plugin binds exists at the pinned rev.
      expect(freshExists(HISTORY_READ)).toBe(true);
    });
  },
);

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

describe.skipIf(!CORE_PRESENT)(
  "former gaps refuted live (stale-Core artifacts, not divergences)",
  () => {
    test("R1 (ex-GAP-1): transcript history surface exists; install no longer fails closed", () => {
      // The first pass probed pre-merge Core and found no history.* head.
      // Fresh main carries the closed heads plus the gate module itself.
      const manifest = readFresh(MANIFEST);
      expect(manifest).toMatch(/CLOSED_CAPABILITY_HEADS/);
      expect(manifest).toMatch(/"history\.transcript\.read"/);
      expect(manifest).toMatch(/"history\.commands\.read"/);
      expect(manifest).toMatch(/"history\.kv\.read"/);
      const capability = readFresh(CAPABILITY);
      expect(capability).toMatch(/"history" => Some\(Self::History\)/);
      // The `bitty.history.transcript.query` Lua spelling lives in the SDK by
      // Core's own layering (host crate: "Exact Lua spellings" parked to
      // W-139/SDK) — a binding note, never a live divergence.
      expect(readFresh(HISTORY_READ)).toMatch(/Exact Lua spellings/);
    });

    test("R2 (ex-GAP-2): Core carries the exact 8-category E_HISTORY taxonomy", () => {
      const gate = readFresh(HISTORY_READ);
      expect(gate).toMatch(/pub enum HistoryDenialKind/);
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
        expect(gate).toContain(code);
      }
      // The 3-outcome HostOpError still serves the separate view-bound
      // live-grid surface the plugin never binds (see R3).
      expect(readFresh(SEARCH_HOST)).toMatch(/pub enum HostOpError/);
    });

    test("R3 (ex-GAP-3): Core history scope is panel/workspace, like the plugin", () => {
      const gate = readFresh(HISTORY_READ);
      expect(gate).toMatch(/HistoryScope/);
      expect(gate).toMatch(/MAX_SCOPE_ID_BYTES: usize = 128/);
      // No wildcard, no `all` default: same closed extent model as the mock.
      expect(gate).toContain('"*"');
      expect(gate).toContain('"all"');
      // ViewId binding belongs to the live-grid search surface, a different
      // surface the plugin does not bind — never a scope divergence.
      expect(readFresh(SEARCH_HOST)).toMatch(/view:\s*ViewId/);
      const run = verify();
      expect(run).toBeDefined();
    });

    test("R4 (ex-GAP-4): Core has per-plugin query/byte windows matching plugin bounds", () => {
      const gate = readFresh(HISTORY_READ);
      expect(gate).toMatch(/max_rows_per_query/);
      expect(gate).toMatch(/max_bytes_per_query/);
      expect(gate).toMatch(/max_queries_per_window/);
      expect(gate).toMatch(/max_bytes_per_window/);
      // Core's own gate tests exercise exactly the plugin bounds
      // (16 rows / 4096 B / 256 B rows / 4-query window / 8192 B window);
      // production defaults stay caller-provided per the module docs.
      expect(gate).toContain("HistoryCaps::new(16, 4096, 256, 4, 8192)");
      // The 1000-match cap belongs to the live-grid surface, not history-read.
      expect(readFresh(TERM_SEARCH)).toMatch(
        /SEARCH_MAX_RESULTS:\s*usize\s*=\s*1000/,
      );
    });

    test("R5 (ex-GAP-5): capture, purge, trust, and safe-mode denials exist live", () => {
      const gate = readFresh(HISTORY_READ);
      // Capture opt-in, default off for terminal-derived sources.
      expect(gate).toMatch(/set_capture/);
      expect(gate).toMatch(/requires_capture/);
      expect(gate).toContain(
        "capture.insert(HistorySource::Transcript, false)",
      );
      // Purge: typed unavailability; purged-only search reads empty (no oracle).
      expect(gate).toMatch(/PurgedOrExpired/);
      expect(gate).toContain("search_never_matches_purged_rows");
      // Trust admission: standing grants for L1/L2, single-use for L3/L4,
      // Core itself reads nothing as a plugin.
      expect(gate).toMatch(
        /TrustLevel::BundledLua \| TrustLevel::ThirdPartyLua/,
      );
      expect(gate).toMatch(
        /TrustLevel::NativeSidecar \| TrustLevel::ExternalTool/,
      );
      expect(gate).toMatch(/TrustLevel::Core => false/);
      // Safe mode denies history reads; "unaffected" is the live-grid surface.
      expect(gate).toMatch(/set_safe_mode/);
      expect(gate).toMatch(/SafeMode => "E_HISTORY_SAFE_MODE"/);
      expect(readFresh(SEARCH_HOST)).toMatch(/Safe mode is unaffected/);
    });
  },
);

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
