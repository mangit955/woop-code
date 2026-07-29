import packageJson from "../package.json";

/**
 * The single source of truth for the Woopcode version.
 *
 * It is imported from package.json rather than restated, so `--version`, the
 * /version and /status commands and the home screen can never disagree with
 * the published package (or with each other), and a release bump needs no
 * follow-up edits.
 */
export const VERSION: string = packageJson.version;
