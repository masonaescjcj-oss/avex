import { readFileSync } from 'node:fs';

/**
 * Which build is running, readable from outside the box.
 *
 * Written because an afternoon went into a question that should have taken one request:
 * a dashboard was redeployed, a server was updated, something failed in between, and
 * nothing anywhere could say which of the two builds was actually serving. The API's
 * surface is identical across the change, so no probe could tell them apart — the only
 * answer was `git log` over SSH, which whoever is debugging may not have.
 *
 * The stamp is a file the installer writes next to the configuration on every run. The
 * API only reads it, and only at startup: a deployment that predates the installer's
 * stamp reports nothing rather than failing to start.
 *
 * A short commit and a timestamp are all it carries. Against a private repository that
 * tells an outsider nothing they can act on, and it is exactly what an operator needs to
 * know whether the thing they just deployed is the thing that is running.
 */
export interface BuildStamp {
  /** Short commit, as the installer recorded it. */
  readonly commit: string;
  readonly branch: string | null;
  /** When the installer built it, ISO 8601. */
  readonly built: string | null;
}

/** Where the installer puts it. Overridable, because not every deployment is that one. */
export const DEFAULT_BUILD_STAMP_FILE = '/etc/avex/build';

/**
 * Parse `key=value` lines. Unknown keys are ignored and a missing commit means no stamp:
 * a half-written file must read as absent rather than as a build nobody can identify.
 */
export function parseBuildStamp(contents: string): BuildStamp | null {
  const fields = new Map<string, string>();
  for (const line of contents.split('\n')) {
    const at = line.indexOf('=');
    if (at <= 0) continue;
    fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }

  const commit = fields.get('commit');
  if (commit === undefined || !/^[0-9a-f]{7,40}$/.test(commit)) return null;

  return {
    commit,
    branch: fields.get('branch') || null,
    built: fields.get('built') || null,
  };
}

/** The stamp, or null if there is not one. Never throws: this is a health endpoint. */
export function readBuildStamp(path: string = DEFAULT_BUILD_STAMP_FILE): BuildStamp | null {
  try {
    return parseBuildStamp(readFileSync(path, 'utf8'));
  } catch {
    // No file, no permission, a directory — all of them mean the same thing to a caller.
    return null;
  }
}
