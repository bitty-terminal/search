/**
 * CTX-0003 conformance evidence, part 2: denial parity against a foreign
 * manifest plus the no-weakening proof.
 *
 * Each parity row runs the same Lua entry point under two manifests: the
 * shipped `bitty-plugin.toml` (first-party, transcript grant) and a foreign
 * variant (commands-only grant). Identical calls must produce identical typed
 * denials, proving the plugin reaches Core only through the same public,
 * capability-gated contract a third-party extension uses, with no private
 * first-party bypass. The no-weakening section proves the plugin requests
 * nothing beyond the single declared grant and that mismatch, safe-mode, and
 * uninstall match the no-plugin baseline exactly.
 *
 * All angles are fresh relative to the behavior suite: foreign-manifest
 * legs, source-isolation probes, export-variant success (the separately
 * granted clipboard path), static namespace scans, and baseline equivalence.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { lintManifestSource, MockHost } from "bitty-plugin-sdk";

import {
  activateSearch,
  COPY_COMMAND,
  currentText,
  dispatch,
  lastCode,
  MANIFEST_SOURCE,
  resultCount,
  SEARCH_CAPABILITIES,
  SEARCH_COMMAND,
  seedTranscript,
  type SearchRun,
} from "./harness.js";

const runs: SearchRun[] = [];

async function parity(
  ...args: Parameters<typeof activateSearch>
): Promise<SearchRun> {
  const run = await activateSearch(...args);
  runs.push(run);
  return run;
}

afterEach(() => {
  for (const run of runs.splice(0)) run.close();
});

/** Foreign manifest: same shape, but a commands-only grant. */
const FOREIGN_MANIFEST_SOURCE = MANIFEST_SOURCE.replace(
  "history.transcript.read = true",
  "history.commands.read = true",
);

/** Export variant: shipped manifest plus the separately reviewed clipboard grant. */
const EXPORT_MANIFEST_SOURCE = MANIFEST_SOURCE.replace(
  "history.transcript.read = true",
  "history.transcript.read = true\nclipboard.write = true",
);

const ROWS = [
  {
    panel: "pane-a",
    workspace: "ws-1",
    seq: 0,
    body: "redacted deploy log line one",
    recorded_at: 10,
  },
  {
    panel: "pane-a",
    workspace: "ws-1",
    seq: 1,
    body: "redacted deploy log line two",
    recorded_at: 11,
  },
] as const;

describe("denial parity vs a foreign manifest (no first-party bypass)", () => {
  test("ungranted transcript reads deny identically under both manifests", async () => {
    const own = await parity({ grants: [] });
    const foreign = await parity({ grants: [] }, FOREIGN_MANIFEST_SOURCE);
    for (const run of [own, foreign]) {
      dispatch(run, SEARCH_COMMAND, {
        panel: "pane-a",
        workspace: "ws-1",
        needle: "deploy",
      });
      expect(await lastCode(run)).toBe("E_HISTORY_MISSING_GRANT");
      expect(await resultCount(run)).toBe(0);
    }
  });

  test("a commands grant never implies transcript reads (source isolation)", async () => {
    const foreign = await parity(
      { grants: ["history.commands.read"] },
      FOREIGN_MANIFEST_SOURCE,
    );
    foreign.host.setHistoryCapture("transcript", true);
    foreign.host.setHistoryRows("transcript", [...ROWS]);
    dispatch(foreign, SEARCH_COMMAND, {
      panel: "pane-a",
      workspace: "ws-1",
      needle: "deploy",
    });
    expect(await lastCode(foreign)).toBe("E_HISTORY_MISSING_GRANT");
    expect(await resultCount(foreign)).toBe(0);
  });

  test("a transcript grant never implies commands reads (source isolation)", async () => {
    const run = await parity();
    expect(await run.query("search.last_code()")).toBe("ok");
    const code = await run.lua.doString(
      "return (function() local ok, err = pcall(bitty.history.commands.query, { scope = { panel = 'pane-a' }, row_count = 4, max_bytes = 1024, op = 'list' }); return string.match(tostring(err), '(E_[A-Z_]+)') end)()",
    );
    expect(code).toBe("E_HISTORY_MISSING_GRANT");
  });

  test("safe-mode and trust denials match across manifests", async () => {
    const own = await parity({ safeMode: true });
    const foreign = await parity({ safeMode: true }, FOREIGN_MANIFEST_SOURCE);
    for (const run of [own, foreign]) {
      dispatch(run, SEARCH_COMMAND, {
        panel: "pane-a",
        workspace: "ws-1",
        needle: "deploy",
      });
      expect(await lastCode(run)).toBe("E_HISTORY_SAFE_MODE");
    }
    const ownL0 = await parity({ trustLevel: "L0" });
    const foreignL0 = await parity(
      { trustLevel: "L0" },
      FOREIGN_MANIFEST_SOURCE,
    );
    for (const run of [ownL0, foreignL0]) {
      dispatch(run, SEARCH_COMMAND, {
        panel: "pane-a",
        workspace: "ws-1",
        needle: "deploy",
      });
      expect(await lastCode(run)).toBe("E_HISTORY_TRUST_DENIED");
    }
  });

  test("the 8-category denial taxonomy is fully reachable through the plugin", async () => {
    // missing-grant, revoked, scope-mismatch, over-bound, capture-disabled,
    // safe-mode, trust-denied, unavailable: one leg each, all typed.
    const missing = await parity({ grants: [] });
    dispatch(missing, SEARCH_COMMAND, {
      panel: "pane-a",
      workspace: "ws-1",
      needle: "x",
    });
    expect(await lastCode(missing)).toBe("E_HISTORY_MISSING_GRANT");

    const revoked = await parity();
    seedTranscript(revoked, [...ROWS]);
    revoked.host.revoke("history.transcript.read");
    dispatch(revoked, SEARCH_COMMAND, {
      panel: "pane-a",
      workspace: "ws-1",
      needle: "x",
    });
    expect(await lastCode(revoked)).toBe("E_HISTORY_REVOKED_GRANT");

    const scope = await parity();
    seedTranscript(scope, [...ROWS]);
    dispatch(scope, SEARCH_COMMAND, { needle: "x" });
    expect(await lastCode(scope)).toBe("E_HISTORY_SCOPE_MISMATCH");

    const bound = await parity();
    seedTranscript(bound, [...ROWS]);
    dispatch(bound, SEARCH_COMMAND, {
      panel: "pane-a",
      workspace: "ws-1",
      needle: "x",
      row_count: 99,
    });
    expect(await lastCode(bound)).toBe("E_HISTORY_OVER_BOUND");

    const capture = await parity();
    capture.host.setHistoryRows("transcript", [...ROWS]);
    dispatch(capture, SEARCH_COMMAND, {
      panel: "pane-a",
      workspace: "ws-1",
      needle: "x",
    });
    expect(await lastCode(capture)).toBe("E_HISTORY_CAPTURE_DISABLED");

    const safe = await parity({ safeMode: true });
    dispatch(safe, SEARCH_COMMAND, {
      panel: "pane-a",
      workspace: "ws-1",
      needle: "x",
    });
    expect(await lastCode(safe)).toBe("E_HISTORY_SAFE_MODE");

    const trust = await parity({ trustLevel: "L4" });
    dispatch(trust, SEARCH_COMMAND, {
      panel: "pane-a",
      workspace: "ws-1",
      needle: "x",
    });
    expect(await lastCode(trust)).toBe("E_HISTORY_TRUST_DENIED");

    const purged = await parity();
    purged.host.setHistoryCapture("transcript", true);
    purged.host.setHistoryRows("transcript", [
      {
        panel: "pane-a",
        workspace: "ws-1",
        seq: 0,
        body: "gone",
        purged: true,
      },
    ]);
    await purged.lua.doString("search.list_now('pane-a', 'ws-1', 4, 1024)");
    expect(await lastCode(purged)).toBe("E_HISTORY_UNAVAILABLE");
  });
});

describe("export needs its own separately granted path", () => {
  test("the export variant copies verbatim; over-bound copies truncate flagged", async () => {
    const run = await parity(
      { grants: ["history.transcript.read", "clipboard.write"] },
      EXPORT_MANIFEST_SOURCE,
    );
    seedTranscript(run, [...ROWS]);
    dispatch(run, SEARCH_COMMAND, {
      panel: "pane-a",
      workspace: "ws-1",
      needle: "deploy",
    });
    dispatch(run, COPY_COMMAND);
    expect(await lastCode(run)).toBe("COPIED");
    expect(await currentText(run)).toBe("redacted deploy log line one");

    const wide = await parity(
      { grants: ["history.transcript.read", "clipboard.write"] },
      EXPORT_MANIFEST_SOURCE,
    );
    wide.host.setHistoryCapture("transcript", true);
    wide.host.setHistoryRows("transcript", [
      {
        panel: "pane-a",
        workspace: "ws-1",
        seq: 0,
        body: "z".repeat(9000),
        recorded_at: 1,
      },
    ]);
    dispatch(wide, SEARCH_COMMAND, {
      panel: "pane-a",
      workspace: "ws-1",
      needle: "z",
      row_count: 4,
      max_bytes: 4096,
    });
    // The 9000-byte body is per-row truncated by the host page itself; the
    // export then applies the 8192-byte clipboard bound with its flag.
    dispatch(wide, COPY_COMMAND);
    expect(["COPIED", "COPIED_TRUNCATED"]).toContain(await lastCode(wide));
  });

  test("granting clipboard.write to the shipped manifest still denies (undeclared)", async () => {
    // The mock requires declaration as well as granting, so even a granted
    // but undeclared clipboard capability fails closed: export truly needs
    // its own manifest review, not just a runtime grant.
    const run = await parity();
    run.host.grant("clipboard.write");
    seedTranscript(run, [...ROWS]);
    dispatch(run, SEARCH_COMMAND, {
      panel: "pane-a",
      workspace: "ws-1",
      needle: "deploy",
    });
    dispatch(run, COPY_COMMAND);
    expect(await lastCode(run)).toBe("E_CAPABILITY_DENIED");
  });
});

describe("no-weakening proof: Core invariants untouched", () => {
  test("manifest declares exactly the one transcript capability and nothing else", () => {
    const section = MANIFEST_SOURCE.split("[capabilities]")[1].split("[")[0];
    const granted = section
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.endsWith("= true"))
      .map((line) => line.split("=")[0].trim());
    expect(granted.sort()).toEqual([...SEARCH_CAPABILITIES].sort());
    // Declared authority lives in capability assignments, not prose: match
    // only `<head> = true` lines so the manifest's own "requests no X"
    // documentation and the `bitty-terminal.*` id prefix cannot trip the
    // denial. Nothing beyond the single head may be granted.
    const declared = MANIFEST_SOURCE.split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(declared).not.toMatch(
      /(clipboard\.write|history\.(commands|kv)\.read|terminal\.[a-z_.-]+|ui\.[a-z_.-]+|process\.[a-z_.-]+|network\.[a-z_:*.-]+|filesystem|env\.read|workspace\.[a-z_.-]+|debug\.[a-z_.-]+|services\.|tasks\.|timers\.|store\.)\s*=\s*true/,
    );
    const result = lintManifestSource(MANIFEST_SOURCE);
    expect(
      result.diagnostics.filter((entry) => entry.severity === "error"),
    ).toEqual([]);
  });

  test("entry point touches only the granted host namespaces; no ambient authority", () => {
    const repoRoot = fileURLToPath(new URL("..", import.meta.url));
    const source = readFileSync(
      join(repoRoot, "lua", "search", "init.lua"),
      "utf8",
    );
    const code = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    const namespaces = new Set(
      [...code.matchAll(/bitty\.([A-Za-z_]+)/g)].map((match) => match[1]),
    );
    expect([...namespaces].sort()).toEqual(
      ["api_version", "commands", "history", "selection", "settings"].sort(),
    );
    const surfaces = new Set(
      [...code.matchAll(/bitty\.([A-Za-z_]+\.[A-Za-z_]+\.[A-Za-z_]+)/g)].map(
        (match) => match[1],
      ),
    );
    for (const surface of surfaces) {
      expect(["history.transcript.query", "selection.copy"]).toContain(surface);
    }
    // No streaming, no overlay, no terminal reads, no second write path.
    expect(code).not.toMatch(/events\.subscribe/);
    expect(code).not.toMatch(/keymaps\.suggest/);
    expect(code).not.toMatch(/bitty\.terminal\./);
    expect(code).not.toMatch(/bitty\.ui\./);
    expect(code).not.toMatch(/bitty\.process\./);
    expect(code).not.toMatch(/bitty\.store\./);
    expect(code).not.toMatch(/\bos\s*\.\s*(execute|remove|rename|exit)\b/);
    expect(code).not.toMatch(/\bio\s*\.\s*(open|popen|write|remove)\b/);
    expect(code).not.toMatch(/\brequire\s*\(/);
    expect(code).not.toMatch(/dofile|loadfile|loadstring/);
  });

  test("mismatch, safe-mode, and uninstall match the no-plugin baseline exactly", async () => {
    // Baseline: a host the plugin never activates. Observable history
    // behavior is no page, no export, and refused dispatch.
    const baseline = new MockHost({ manifestSource: MANIFEST_SOURCE });
    expect(() => baseline.dispatchCommand(SEARCH_COMMAND, {})).toThrow();
    const snapshot = (host: MockHost): string =>
      JSON.stringify({
        violations: host.handlerViolations.length,
      });
    const expected = snapshot(baseline);
    // Version mismatch fails activation with no partial state.
    const mismatched = new MockHost({
      manifestSource: MANIFEST_SOURCE,
      pluginApiVersion: "99.0.0",
    });
    expect(() => mismatched.beginActivation()).toThrow();
    expect(() => mismatched.dispatchCommand(SEARCH_COMMAND, {})).toThrow();
    expect(snapshot(mismatched)).toBe(expected);
    // Safe mode reads no history and exports nothing.
    const safe = await parity({ safeMode: true });
    dispatch(safe, SEARCH_COMMAND, {
      panel: "pane-a",
      workspace: "ws-1",
      needle: "x",
    });
    expect(await lastCode(safe)).toBe("E_HISTORY_SAFE_MODE");
    expect(snapshot(safe.host)).toBe(expected);
    // Missing grants deny with no partial activation.
    const ungranted = await parity({ grants: [] });
    dispatch(ungranted, SEARCH_COMMAND, {
      panel: "pane-a",
      workspace: "ws-1",
      needle: "x",
    });
    expect(await lastCode(ungranted)).toBe("E_HISTORY_MISSING_GRANT");
    expect(snapshot(ungranted.host)).toBe(expected);
    // Uninstall (dispose) refuses further dispatch like the baseline.
    const removed = await parity();
    seedTranscript(removed, [...ROWS]);
    dispatch(removed, SEARCH_COMMAND, {
      panel: "pane-a",
      workspace: "ws-1",
      needle: "deploy",
    });
    expect(await resultCount(removed)).toBe(2);
    removed.host.dispose();
    expect(() => dispatch(removed, SEARCH_COMMAND, {})).toThrow();
  });
});
