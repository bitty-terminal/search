/**
 * Runs `lua/search/init.lua` in a real Lua VM (wasmoon) against the SDK
 * mock host (bitty-plugin-sdk `MockHost`).
 *
 * The mock host owns every contract check: manifest linting, capability
 * gates, the activation registration window, scope explicitness, capture
 * opt-in, row/byte bounds, per-plugin window budgets, purge/trust/safe-mode
 * denials, and the clipboard export gate. The harness only bridges the
 * injected `bitty` table into Lua, dispatches the plugin commands, seeds
 * already-redacted history rows, and exposes scalar state queries so tests
 * assert on plain values.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { MockHost } from "bitty-plugin-sdk";
import { LuaFactory, type LuaEngine } from "wasmoon";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const MANIFEST_SOURCE = readFileSync(
  join(REPO_ROOT, "bitty-plugin.toml"),
  "utf8",
);
export const ENTRY_SOURCE = readFileSync(
  join(REPO_ROOT, "lua/search/init.lua"),
  "utf8",
);

/** Capabilities the manifest requests; tests grant all of them by default. */
export const SEARCH_CAPABILITIES = ["history.transcript.read"] as const;

export const SEARCH_COMMAND = "bitty-terminal.search:search";
export const NEXT_COMMAND = "bitty-terminal.search:next";
export const PREV_COMMAND = "bitty-terminal.search:prev";
export const CLEAR_COMMAND = "bitty-terminal.search:clear";
export const COPY_COMMAND = "bitty-terminal.search:copy";

export interface SearchRun {
  readonly host: MockHost;
  readonly lua: LuaEngine;
  /** Scalar Lua state query: `search.result_count()`, `search.last_code()`. */
  query(expr: string): Promise<unknown>;
  close(): void;
}

export interface SearchRunOptions {
  readonly grants?: readonly string[];
  readonly settings?: Readonly<Record<string, unknown>>;
  readonly environment?: Readonly<Record<string, string>>;
  readonly safeMode?: boolean;
  readonly trustLevel?: string;
  readonly pluginApiVersion?: string;
}

const factory = new LuaFactory();

/**
 * Map JS `null` results to `undefined` so they reach Lua as `nil` (the
 * mock host models Lua `nil` as `null`; wasmoon cannot push `null`).
 */
function nilSafe<T>(table: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(table as Record<string, unknown>)) {
    if (typeof value === "function") {
      out[key] = (...args: unknown[]): unknown => {
        const result = (value as (...a: unknown[]) => unknown)(...args);
        return result === null ? undefined : result;
      };
    } else if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      out[key] = nilSafe(value);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

/** Activate the plugin once: grants, settings, init.lua, end activation. */
export async function activateSearch(
  options: SearchRunOptions = {},
  manifestSource: string = MANIFEST_SOURCE,
): Promise<SearchRun> {
  const host = new MockHost({
    manifestSource,
    ...(options.environment !== undefined
      ? { environment: options.environment }
      : {}),
    ...(options.safeMode !== undefined ? { safeMode: options.safeMode } : {}),
    ...(options.trustLevel !== undefined
      ? { trustLevel: options.trustLevel }
      : {}),
    ...(options.pluginApiVersion !== undefined
      ? { pluginApiVersion: options.pluginApiVersion }
      : {}),
  });
  for (const capability of options.grants ?? SEARCH_CAPABILITIES) {
    host.grant(capability);
  }
  host.beginActivation();
  for (const [key, value] of Object.entries(options.settings ?? {})) {
    host.bitty.settings.set(key, value as never);
  }

  const lua = await factory.createEngine({ injectObjects: false });
  lua.global.set("bitty", nilSafe(host.bitty));
  const run: SearchRun = {
    host,
    lua,
    async query(expr: string): Promise<unknown> {
      return lua.doString(`return ${expr}`);
    },
    close(): void {
      lua.global.close();
    },
  };
  try {
    await lua.doString(ENTRY_SOURCE);
    host.endActivation();
  } catch (error) {
    lua.global.close();
    throw error;
  }
  return run;
}

/** Dispatch a session command by qualified name. */
export function dispatch(
  run: SearchRun,
  command: string,
  args: unknown = {},
): unknown {
  return run.host.dispatchCommand(command, args);
}

/** Seed already-redacted transcript rows with capture opt-in on. */
export function seedTranscript(
  run: SearchRun,
  rows: ReadonlyArray<Record<string, unknown>>,
): void {
  run.host.setHistoryCapture("transcript", true);
  run.host.setHistoryRows("transcript", rows as never);
}

/** Scalar state readers (plain values, no table conversion). */
export async function resultCount(run: SearchRun): Promise<number> {
  return (await run.query("search.result_count()")) as number;
}

export async function currentIndex(run: SearchRun): Promise<number> {
  return (await run.query("search.current_index()")) as number;
}

export async function currentText(run: SearchRun): Promise<string> {
  return (await run.query("search.current_text()")) as string;
}

export async function currentLabel(run: SearchRun): Promise<string> {
  return (await run.query("search.current_label()")) as string;
}

export async function lastCode(run: SearchRun): Promise<string> {
  return (await run.query("search.last_code()")) as string;
}

export async function totalInScope(run: SearchRun): Promise<number> {
  return (await run.query("search.total_in_scope()")) as number;
}
