/**
 * Type definitions for the vinext CLI command framework.
 *
 * A command is described declaratively by a {@link CommandSpec}: its name, a
 * one-line summary, an optional longer description, its flags ({@link ArgSpec}),
 * positionals, and examples. This single spec is the source of truth for *both*
 * argument parsing (see `./parse.ts`) and help text generation (see `./help.ts`),
 * so the two can never drift out of sync.
 *
 * The `run` callback receives a fully parsed, typed {@link CommandContext}.
 */

/**
 * The supported argument value kinds.
 *
 *  - `boolean`     — a flag with no value (`--verbose`). Always defined (false when absent).
 *  - `string`      — an arbitrary string value (`--hostname localhost`).
 *  - `int`         — any integer, validated with strict `Number()` parsing.
 *  - `port`        — an integer in the valid TCP port range (0–65535).
 *  - `positiveInt` — an integer greater than zero.
 */
export type ArgType = "boolean" | "string" | "int" | "port" | "positiveInt";

/** Declarative description of a single CLI flag. */
export type ArgSpec = {
  /** Value kind. Drives both parsing/validation and the help placeholder. */
  type: ArgType;
  /** Single-letter short alias, without the dash (e.g. `"p"` for `-p`). */
  short?: string;
  /** Human-readable description, shown in the command's `--help` output. */
  description: string;
  /**
   * Placeholder shown in help for value-taking flags. Rendered wrapped in
   * angle brackets, e.g. `valueHint: "port"` → `--port <port>`. Ignored for
   * `boolean` args. Defaults to the arg's type name when omitted.
   */
  valueHint?: string;
  /**
   * Default value applied at runtime when the flag is absent, and shown in
   * help as `(default: …)`. For `boolean` args the default is always `false`.
   */
  default?: string | number | boolean;
  /** Allow the flag to be repeated; values are collected into an array. */
  multiple?: boolean;
};

/** A named positional argument, used only for help/usage rendering. */
export type PositionalSpec = {
  /** Display name, e.g. `"directory"`. Rendered as `[directory]` in usage. */
  name: string;
  /** Description shown under the "Arguments" help section. */
  description: string;
  /** Whether this positional accepts multiple values (`[directory...]`). */
  variadic?: boolean;
};

/** An example invocation shown under the "Examples" help section. */
export type ExampleSpec = {
  /** The full command line, e.g. `"vinext dev -p 4000"`. */
  command: string;
  /** Optional explanation rendered alongside the command. */
  description?: string;
};

/** Maps a single {@link ArgSpec} to its parsed scalar value type. */
type ScalarValue<S extends ArgSpec> = S["type"] extends "string" ? string : number;

/**
 * Infers the shape of the parsed `values` object from an args spec.
 *
 *  - `boolean` flags are always present (`false` when absent).
 *  - `multiple` flags become arrays.
 *  - flags with a `default` are always present.
 *  - all other value flags are `T | undefined`.
 */
export type InferValues<A extends Record<string, ArgSpec>> = {
  [K in keyof A]: A[K]["type"] extends "boolean"
    ? boolean
    : A[K]["multiple"] extends true
      ? ScalarValue<A[K]>[]
      : A[K] extends { default: string | number }
        ? ScalarValue<A[K]>
        : ScalarValue<A[K]> | undefined;
};

/** The parsed, typed context handed to a command's `run` callback. */
export type CommandContext<A extends Record<string, ArgSpec>> = {
  /** Parsed and coerced flag values, keyed by arg name. */
  values: InferValues<A>;
  /** Positional arguments, in order, with consumed flag values removed. */
  positionals: string[];
};

/**
 * Declarative description of a CLI command. This is the single source of truth
 * for argument parsing and help generation.
 */
export type CommandSpec<A extends Record<string, ArgSpec> = Record<string, ArgSpec>> = {
  /** The subcommand name, e.g. `"dev"`. */
  name: string;
  /** One-line summary shown in the top-level command list. */
  summary: string;
  /** Longer description shown in the command's own `--help` output. */
  description?: string;
  /** Overrides the default `vinext <name> [options]` usage line. */
  usage?: string;
  /** Flag definitions. A `--help`/`-h` flag is always injected automatically. */
  args?: A;
  /** Positional argument definitions (help/usage only). */
  positionals?: PositionalSpec[];
  /** Example invocations shown under "Examples". */
  examples?: ExampleSpec[];
  /** Free-form trailing help text (e.g. notes about experimental flags). */
  notes?: string;
  /** Command implementation. Receives the parsed, typed context. */
  run: (ctx: CommandContext<A>) => void | Promise<void>;
};
