/**
 * Search behavior against the SDK mock host: bounded scoped snapshot queries
 * with typed denials and untrusted labels, result navigation over the cached
 * page, grant-gated export, and version/capability mismatch disable.
 *
 * The mock host owns every capability, registration, scope, bound, capture,
 * budget, purge, trust, and safe-mode check; tests assert plugin policy
 * (presentation state, page replacement, cursor clamping, verbatim export)
 * and that history is read only through an explicitly scoped
 * `history.transcript.query` while export needs its own separate grant.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { lintManifestSource, MockHost } from "bitty-plugin-sdk";
import { LuaFactory } from "wasmoon";

import {
  activateSearch,
  CLEAR_COMMAND,
  COPY_COMMAND,
  currentLabel,
  currentText,
  dispatch,
  ENTRY_SOURCE,
  lastCode,
  MANIFEST_SOURCE,
  NEXT_COMMAND,
  PREV_COMMAND,
  resultCount,
  SEARCH_CAPABILITIES,
  SEARCH_COMMAND,
  seedTranscript,
  totalInScope,
  type SearchRun,
} from "./harness.js";

const runs: SearchRun[] = [];

async function search(
  ...args: Parameters<typeof activateSearch>
): Promise<SearchRun> {
  const run = await activateSearch(...args);
  runs.push(run);
  return run;
}

afterEach(() => {
  for (const run of runs.splice(0)) run.close();
});

const ROWS = [
  {
    panel: "pane-a",
    workspace: "ws-1",
    seq: 0,
    body: "redacted deploy log line one",
    command: "make check",
    recorded_at: 10,
    actor: "user",
  },
  {
    panel: "pane-a",
    workspace: "ws-1",
    seq: 1,
    body: "redacted deploy log line two",
    command: "make check",
    recorded_at: 11,
    actor: "user",
  },
  {
    panel: "pane-b",
    workspace: "ws-1",
    seq: 2,
    body: "foreign panel bytes never cross",
    recorded_at: 12,
  },
] as const;

function query(
  run: SearchRun,
  needle: string,
  extra: Record<string, unknown> = {},
): unknown {
  return dispatch(run, SEARCH_COMMAND, {
    panel: "pane-a",
    workspace: "ws-1",
    needle,
    ...extra,
  });
}

describe("manifest", () => {
  test("passes the authoritative SDK linter with zero errors", () => {
    const result = lintManifestSource(MANIFEST_SOURCE);
    expect(
      result.diagnostics.filter((entry) => entry.severity === "error"),
    ).toEqual([]);
  });

  test("high-risk consent warning names exactly the transcript grant", () => {
    const result = lintManifestSource(MANIFEST_SOURCE);
    expect(
      result.diagnostics.map((entry) => `${entry.code}:${entry.path}`).sort(),
    ).toEqual(["capabilities.high-risk:history.transcript.read"]);
  });

  test("declares exactly the minimal public capability set", () => {
    expect([...SEARCH_CAPABILITIES].sort()).toEqual(
      ["history.transcript.read"].sort(),
    );
  });
});

describe("pure policy without a host", () => {
  test("the entry point loads with bitty absent and checks compat", async () => {
    const factory = new LuaFactory();
    const lua = await factory.createEngine({ injectObjects: false });
    try {
      await lua.doString(ENTRY_SOURCE);
      expect(await lua.doString("return search.check_compat('1.0.0')")).toBe(
        true,
      );
      expect(await lua.doString("return search.check_compat('1.9.9')")).toBe(
        true,
      );
      expect(await lua.doString("return search.check_compat('2.0.0')")).toBe(
        false,
      );
      expect(await lua.doString("return search.check_compat('0.9.0')")).toBe(
        false,
      );
      expect(await lua.doString("return search.check_compat('nope')")).toBe(
        false,
      );
      expect(
        await lua.doString(
          "return (function() local _, err = search.validate_scope_id('*', 'panel') return err end)()",
        ),
      ).toMatch(/never be/);
      expect(
        await lua.doString(
          "return (function() local _, err = search.validate_scope_id('all', 'workspace') return err end)()",
        ),
      ).toMatch(/never be/);
      expect(
        await lua.doString(
          "return (function() local _, err = search.validate_needle('') return err end)()",
        ),
      ).toMatch(/must not be empty/);
      expect(
        await lua.doString(
          "return (function() local _, err = search.validate_bounds(0, 4096) return err end)()",
        ),
      ).toMatch(/row_count/);
      expect(
        await lua.doString(
          "return (function() local _, code = search.step_cursor(2, 2, 1) return code end)()",
        ),
      ).toBe("AT_LAST");
      expect(
        await lua.doString(
          "return (function() local _, code = search.step_cursor(2, 1, -1) return code end)()",
        ),
      ).toBe("AT_FIRST");
    } finally {
      lua.global.close();
    }
  });
});

describe("snapshot search lifecycle over the public history API", () => {
  test("search finds scoped rows with untrusted labels; navigation clamps; clear drops", async () => {
    const run = await search();
    seedTranscript(run, [...ROWS]);
    query(run, "deploy log");
    expect(await lastCode(run)).toBe("FOUND");
    expect(await resultCount(run)).toBe(2);
    expect(await totalInScope(run)).toBe(2);
    // Source isolation: the foreign panel row never crosses into the page.
    expect(await currentText(run)).toBe("redacted deploy log line one");
    expect(await currentLabel(run)).toBe("untrusted-observation");

    dispatch(run, NEXT_COMMAND);
    expect(await currentText(run)).toBe("redacted deploy log line two");
    // Clamped at the last cached match: no re-query, no stream, cursor stays.
    dispatch(run, NEXT_COMMAND);
    expect(await lastCode(run)).toBe("AT_LAST");
    expect(await currentText(run)).toBe("redacted deploy log line two");

    dispatch(run, PREV_COMMAND);
    expect(await currentText(run)).toBe("redacted deploy log line one");
    dispatch(run, PREV_COMMAND);
    expect(await lastCode(run)).toBe("AT_FIRST");

    dispatch(run, CLEAR_COMMAND);
    expect(await lastCode(run)).toBe("CLEARED");
    expect(await resultCount(run)).toBe(0);
    // Navigating an empty page fails closed with NO_RESULTS.
    dispatch(run, NEXT_COMMAND);
    expect(await lastCode(run)).toBe("NO_RESULTS");
  });

  test("a refresh replaces the cached page; empty results report EMPTY", async () => {
    const run = await search();
    seedTranscript(run, [...ROWS]);
    query(run, "deploy log");
    expect(await resultCount(run)).toBe(2);
    // Refresh replaces, never appends: the narrower needle yields one row.
    query(run, "line two");
    expect(await lastCode(run)).toBe("FOUND");
    expect(await resultCount(run)).toBe(1);
    expect(await currentText(run)).toBe("redacted deploy log line two");
    // A needle matching nothing is an empty page, not a denial.
    query(run, "no such bytes anywhere");
    expect(await lastCode(run)).toBe("EMPTY");
    expect(await resultCount(run)).toBe(0);
  });

  test("list and tail share the same gate through the Lua entries", async () => {
    const run = await search();
    seedTranscript(run, [...ROWS]);
    await run.lua.doString("search.list_now('pane-a', 'ws-1', 10, 4096)");
    expect(await lastCode(run)).toBe("FOUND");
    expect(await resultCount(run)).toBe(2);
    await run.lua.doString("search.tail_now('pane-a', 'ws-1', 1, 4096)");
    expect(await lastCode(run)).toBe("FOUND");
    expect(await resultCount(run)).toBe(1);
    expect(await currentText(run)).toBe("redacted deploy log line two");
  });

  test("denied refresh keeps the previous page intact", async () => {
    const run = await search();
    seedTranscript(run, [...ROWS]);
    query(run, "deploy log");
    expect(await resultCount(run)).toBe(2);
    // Revoke mid-session: the denied refresh surfaces the typed code while
    // the previous page stays navigable.
    run.host.revoke("history.transcript.read");
    query(run, "deploy log");
    expect(await lastCode(run)).toBe("E_HISTORY_REVOKED_GRANT");
    expect(await resultCount(run)).toBe(2);
    expect(await currentText(run)).toBe("redacted deploy log line one");
  });

  test("export without the separate clipboard grant denies and keeps the page", async () => {
    const run = await search();
    seedTranscript(run, [...ROWS]);
    query(run, "deploy log");
    dispatch(run, COPY_COMMAND);
    expect(await lastCode(run)).toBe("E_CAPABILITY_DENIED");
    expect(await resultCount(run)).toBe(2);
    expect(await currentText(run)).toBe("redacted deploy log line one");
  });
});

describe("typed denials from the host gate", () => {
  test("missing grant denies before capture, scope, or bounds run", async () => {
    const run = await search({ grants: [] });
    query(run, "deploy log");
    expect(await lastCode(run)).toBe("E_HISTORY_MISSING_GRANT");
    expect(await resultCount(run)).toBe(0);
  });

  test("capture opt-in off denies with the typed code", async () => {
    const run = await search();
    run.host.setHistoryRows("transcript", [...ROWS]);
    query(run, "deploy log");
    expect(await lastCode(run)).toBe("E_HISTORY_CAPTURE_DISABLED");
    expect(await resultCount(run)).toBe(0);
  });

  test("unscoped queries deny; wildcard scopes are malformed", async () => {
    const run = await search();
    seedTranscript(run, [...ROWS]);
    dispatch(run, SEARCH_COMMAND, { needle: "deploy log" });
    expect(await lastCode(run)).toBe("E_HISTORY_SCOPE_MISMATCH");
    dispatch(run, SEARCH_COMMAND, {
      panel: "*",
      workspace: "ws-1",
      needle: "deploy log",
    });
    expect(await lastCode(run)).toBe("E_DEF_INVALID");
    dispatch(run, SEARCH_COMMAND, {
      panel: "pane-a",
      workspace: "all",
      needle: "deploy log",
    });
    expect(await lastCode(run)).toBe("E_DEF_INVALID");
    expect(await resultCount(run)).toBe(0);
  });

  test("over-bound rows, bytes, and needles deny without clamping", async () => {
    const run = await search();
    seedTranscript(run, [...ROWS]);
    query(run, "deploy log", { row_count: 17 });
    expect(await lastCode(run)).toBe("E_HISTORY_OVER_BOUND");
    query(run, "deploy log", { max_bytes: 4097 });
    expect(await lastCode(run)).toBe("E_HISTORY_OVER_BOUND");
    query(run, "");
    expect(await lastCode(run)).toBe("E_HISTORY_OVER_BOUND");
    query(run, "x".repeat(257));
    expect(await lastCode(run)).toBe("E_HISTORY_OVER_BOUND");
    expect(await resultCount(run)).toBe(0);
  });

  test("safe mode and untrusted levels read no history", async () => {
    const safe = await search({ safeMode: true });
    seedTranscript(safe, [...ROWS]);
    query(safe, "deploy log");
    expect(await lastCode(safe)).toBe("E_HISTORY_SAFE_MODE");
    const l0 = await search({ trustLevel: "L0" });
    seedTranscript(l0, [...ROWS]);
    query(l0, "deploy log");
    expect(await lastCode(l0)).toBe("E_HISTORY_TRUST_DENIED");
  });

  test("purged-only list denies typed; purged-only search is an empty page", async () => {
    const run = await search();
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
    // Search excludes purged rows before matching, so a needle matching only
    // purged content yields an empty page rather than an existence oracle.
    await run.lua.doString(
      "search.search_now('pane-a', 'ws-1', 'gone', 10, 4096)",
    );
    expect(await lastCode(run)).toBe("EMPTY");
    expect(await resultCount(run)).toBe(0);
  });

  test("window budgets deny over-rate queries instead of throttling silently", async () => {
    const run = await search();
    seedTranscript(run, [...ROWS]);
    for (let i = 0; i < 4; i += 1) {
      query(run, "deploy log");
      expect(await lastCode(run)).toBe("FOUND");
    }
    query(run, "deploy log");
    expect(await lastCode(run)).toBe("E_HISTORY_OVER_BOUND");
    // The denied fifth query leaves the fourth page intact.
    expect(await resultCount(run)).toBe(2);
  });
});

describe("mismatch disables with a diagnostic; fallback stays Core", () => {
  test("host-level API mismatch fails activation with no partial state", () => {
    const host = new MockHost({
      manifestSource: MANIFEST_SOURCE,
      pluginApiVersion: "99.0.0",
    });
    expect(() => host.beginActivation()).toThrow(/E_LIFECYCLE_STATE/);
    expect(() => host.dispatchCommand(SEARCH_COMMAND, {})).toThrow(
      /E_GENERATION_DISPOSED/,
    );
  });

  test("plugin-level mismatch disables with a diagnostic and registers nothing", async () => {
    const factory = new LuaFactory();
    const lua = await factory.createEngine({ injectObjects: false });
    try {
      const seen: string[] = [];
      lua.global.set("bitty", {
        api_version: "99.0.0",
        settings: {
          get: () => undefined,
          set: () => true,
        },
        commands: {
          register: () => {
            seen.push("register");
            return 1;
          },
        },
        events: {
          subscribe: () => {
            seen.push("subscribe");
            return 1;
          },
        },
        keymaps: {
          suggest: () => {
            seen.push("suggest");
            return 1;
          },
        },
      });
      await lua.doString(ENTRY_SOURCE);
      expect(seen).toEqual([]);
      expect(await lua.doString("return search.disabled")).toBe(true);
      expect(await lua.doString("return search.disabled_reason")).toMatch(
        /\^1\.0/,
      );
    } finally {
      lua.global.close();
    }
  });

  test("bad default bounds fall back without widening a query", async () => {
    const run = await search({
      settings: { row_count: 9999, max_bytes: -3 },
    });
    expect(await run.query("search.last_code()")).toBe("BOUNDS_FALLBACK");
    seedTranscript(run, [...ROWS]);
    query(run, "deploy log");
    expect(await lastCode(run)).toBe("FOUND");
    expect(await resultCount(run)).toBe(2);
  });

  test("disposing the plugin leaves history untouched (Core fallback)", async () => {
    const run = await search();
    seedTranscript(run, [...ROWS]);
    query(run, "deploy log");
    expect(await resultCount(run)).toBe(2);
    run.host.dispose();
    expect(() => dispatch(run, SEARCH_COMMAND, {})).toThrow();
  });
});
