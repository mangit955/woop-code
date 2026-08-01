/**
 * Where does a command write?
 *
 * One entry per write-capable command, each answering the same question: given
 * this argument list, which tokens name a place on disk it will touch. The
 * classifier asks that question once and applies the boundary rule to the
 * answer, which is what keeps `cp` and `tee` from needing different treatment.
 *
 * Two things make this table hard to get wrong:
 *
 *  - **A command with no entry cannot be a workspace write.** The classifier
 *    escalates it instead, so forgetting an entry over-asks rather than leaking.
 *  - **An extractor is a function, not a shape.** Destinations live in a
 *    positional for `mkdir`, in `-o` for `go build`, inside the program text for
 *    `awk`, and in three different places for `git`. A per-command function
 *    states that directly; an enum would have to grow a case for each.
 *
 * Sources count as destinations wherever a command reads one path and writes
 * another. `cp /etc/shadow .` stays inside the workspace by the letter of the
 * rule and still crosses the boundary, so both ends are checked.
 */

import { UNRESOLVABLE } from "./paths";

export type DestinationExtractor = (args: string[]) => string[];

/**
 * Reads the value of a flag whether it was written `--flag=value`,
 * `--flag value`, `-o value` or `-ovalue`. The attached forms are the ones that
 * hide a path from a naive `startsWith("-")` filter.
 */
export function flagValues(args: string[], flags: Set<string>): string[] {
  const values: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    if (token === "--") break;

    if (token.startsWith("--")) {
      const equals = token.indexOf("=");
      const name = equals === -1 ? token : token.slice(0, equals);
      if (!flags.has(name)) continue;
      values.push(equals === -1 ? (args[index + 1] ?? UNRESOLVABLE) : token.slice(equals + 1));
      continue;
    }

    if (!token.startsWith("-") || token.length < 2) continue;

    for (const flag of flags) {
      if (flag.startsWith("--")) continue;
      if (token === flag) {
        values.push(args[index + 1] ?? UNRESOLVABLE);
      } else if (token.startsWith(flag)) {
        values.push(token.slice(flag.length));
      }
    }
  }

  return values;
}

interface PositionalOptions {
  /** Flags whose following token is a value, not a path. */
  valueFlags?: Set<string>;
  /** Leading positionals to drop: a subcommand, a sed script. */
  skip?: number;
}

/** Every argument that is not a flag or a flag's value, in order. */
export function positionals(args: string[], options: PositionalOptions = {}): string[] {
  const valueFlags = options.valueFlags ?? new Set<string>();
  const found: string[] = [];
  let afterSeparator = false;

  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;

    if (afterSeparator) {
      found.push(token);
      continue;
    }

    if (token === "--") {
      afterSeparator = true;
      continue;
    }

    if (token.startsWith("-") && token.length > 1) {
      // `--flag=value` carries its own value; `--flag value` eats the next token.
      if (valueFlags.has(token)) index += 1;
      continue;
    }

    found.push(token);
  }

  return found.slice(options.skip ?? 0);
}

// ─── Per-command extractors ──────────────────────────────────────────────────

const COPY_TARGET_FLAGS = new Set(["-t", "--target-directory"]);
const copy: DestinationExtractor = (args) => [
  ...positionals(args, { valueFlags: new Set(["-S", "--suffix", "-t", "--target-directory"]) }),
  ...flagValues(args, COPY_TARGET_FLAGS),
];

const touch: DestinationExtractor = (args) => [
  ...positionals(args, { valueFlags: new Set(["-d", "--date", "-t", "-r", "--reference"]) }),
  ...flagValues(args, new Set(["-r", "--reference"])),
];

const mkdir: DestinationExtractor = (args) =>
  positionals(args, { valueFlags: new Set(["-m", "--mode"]) });

/** `patch -d /etc -p1 < diff` applies the diff somewhere else entirely. */
const patch: DestinationExtractor = (args) => [
  ...positionals(args, { valueFlags: new Set(["-p", "--strip", "-F", "-D"]) }),
  ...flagValues(
    args,
    new Set(["-d", "--directory", "-o", "--output", "-i", "--input", "-r", "--reject-file", "-B"]),
  ),
];
// Note: the paths inside the diff body are not visible here. A diff naming
// `../../etc/x` applies there regardless of what the argument list says.

/**
 * `sed -i` rewrites every file it is given. The script is a positional too and
 * is dropped, so `s|/usr|/opt|` is not mistaken for a path to /usr.
 */
const sed: DestinationExtractor = (args) => {
  const scriptFlags = new Set(["-e", "--expression", "-f", "--file"]);
  const hasScriptFlag = args.some(
    (arg) => scriptFlags.has(arg) || [...scriptFlags].some((flag) => arg.startsWith(`${flag}=`)),
  );

  const files = positionals(args, {
    valueFlags: new Set([...scriptFlags, "-l", "--line-length", "-i"]),
    // Without -e/-f the first positional is the script itself.
    skip: hasScriptFlag ? 0 : 1,
  });

  return [...files, ...flagValues(args, new Set(["-f", "--file"]))];
};

/**
 * gawk's `print > "file"` is a write hidden in the program text. A redirect
 * whose target is not a literal is a destination we cannot name, so it is
 * reported as unresolvable rather than assumed local.
 */
const awk: DestinationExtractor = (args) => {
  const program = args.filter((arg) => !arg.startsWith("-")).join(" ");
  const targets: string[] = [];
  const literal = />>?\s*"([^"]*)"/g;

  let match: RegExpExecArray | null;
  while ((match = literal.exec(program)) !== null) targets.push(match[1]!);

  return targets.length > 0 ? targets : [UNRESOLVABLE];
};

const cargo: DestinationExtractor = (args) =>
  flagValues(args, new Set(["--target-dir", "--out-dir", "--manifest-path", "--root"]));

/** Package patterns like `./...` write nothing; `-o` does. */
const go: DestinationExtractor = (args) =>
  flagValues(args, new Set(["-o", "-C", "-modfile", "-pkgdir", "-overlay"]));

/** Global flags that move git's idea of where the repository is. */
export const GIT_LOCATION_FLAGS = new Set(["-C", "--git-dir", "--work-tree", "--exec-path"]);

/**
 * Subcommands whose positionals are paths, and how many leading words to skip
 * to get past the subcommand itself. `git worktree add ../wt` needs two.
 */
const GIT_PATH_SUBCOMMANDS: Record<string, number> = {
  init: 1,
  add: 1,
  mv: 1,
  apply: 1,
  checkout: 1,
  restore: 1,
  clean: 1,
  worktree: 2,
  submodule: 2,
};

const git: DestinationExtractor = (args) => {
  const locations = flagValues(args, GIT_LOCATION_FLAGS);
  const words = positionals(args, { valueFlags: new Set([...GIT_LOCATION_FLAGS, "-m", "--message"]) });
  const subcommand = words[0];
  const skip = subcommand ? GIT_PATH_SUBCOMMANDS[subcommand] : undefined;

  return [
    ...locations,
    ...flagValues(args, new Set(["--directory", "--separate-git-dir", "--template"])),
    ...(skip === undefined ? [] : words.slice(skip)),
  ];
};

/**
 * Every command that is allowed to be an ordinary workspace write. Anything
 * absent from this table can never be classified as one.
 */
export const DESTINATIONS: Record<string, DestinationExtractor> = {
  mkdir,
  touch,
  tee: (args) => positionals(args),
  ln: (args) => positionals(args, { valueFlags: new Set(["-S", "--suffix", "-t"]) }),
  cp: copy,
  mv: copy,
  patch,
  sed,
  awk,
  gawk: awk,
  git,
  cargo,
  go,
};

/**
 * Destinations for a command, or `undefined` when it has not declared any.
 * `undefined` is not "no destinations" — it is "unknown", and the classifier
 * treats the two differently.
 */
export function destinationsOf(name: string, args: string[]): string[] | undefined {
  const extract = DESTINATIONS[name];
  if (!extract) return undefined;

  // A bare `-` is stdin, and an empty token is not a path at all.
  return extract(args).filter((destination) => destination !== "" && destination !== "-");
}
