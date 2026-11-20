import { stat } from "node:fs/promises";
import { resolve } from "node:path";

const FLAG_PREFIX = "-";

export interface LaunchArguments {
  /** `process.defaultApp`: an unpackaged run, whose first argument after the flags is the entry script. */
  readonly defaultApp: boolean;
  /** The directory the launching process ran in, for paths given relative to it. */
  readonly cwd: string;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * The files a command line names (plan 163, decision 7): Windows Explorer, Linux file managers and
 * a terminal hand the path as an argument. Chromium and Playwright add flags in front of the entry
 * script, so flags are skipped wherever they are rather than by position; anything that is not an
 * existing regular file is too, so a stray argument never becomes an error notice.
 */
export async function launchPathsOf(argv: readonly string[], options: LaunchArguments): Promise<readonly string[]> {
  const candidates: string[] = [];
  let entrySkipped = !options.defaultApp;
  for (const argument of argv.slice(1)) {
    if (argument === "" || argument.startsWith(FLAG_PREFIX)) continue;
    if (!entrySkipped) {
      entrySkipped = true;
      continue;
    }
    const path = resolve(options.cwd, argument);
    if (!candidates.includes(path)) candidates.push(path);
  }
  const files = await Promise.all(candidates.map(isFile));
  return candidates.filter((_, index) => files[index]);
}

/** Paths the OS asked TableCraft to open, held until a window can take them (plan 163, decision 9). */
export interface LaunchFiles {
  /** The OS named files: pushed to the window when it is listening, held otherwise. */
  arrive(paths: readonly string[]): void;
  /** The window restored its layout: hands over what is held, and later arrivals are pushed. */
  take(): readonly string[];
  /** A window started loading; arrivals are held until it takes them. */
  rendererLoading(): void;
}

/** `push` sends paths to the window; it answers false when there is no window to send them to. */
export function createLaunchFiles(push: (paths: readonly string[]) => boolean): LaunchFiles {
  let held: string[] = [];
  let listening = false;
  const hold = (paths: readonly string[]) => {
    for (const path of paths) if (!held.includes(path)) held.push(path);
  };
  return {
    arrive(paths) {
      if (paths.length === 0) return;
      if (listening && push(paths)) return;
      hold(paths);
    },
    take() {
      const taken = held;
      held = [];
      listening = true;
      return taken;
    },
    rendererLoading() {
      listening = false;
    },
  };
}
