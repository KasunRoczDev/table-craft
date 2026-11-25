const ANY_RUN = "*";
const ANY_ONE = "?";

/**
 * Whether `name` matches `glob`, by the greedy wildcard walk that backtracks only to the last `*`,
 * so it takes time linear in their lengths; a regex built from `a*a*a*…b` backtracks exponentially.
 */
function wildcardMatch(glob: readonly string[], name: readonly string[]): boolean {
  let at = 0;
  let from = 0;
  let star = -1;
  let resume = 0;
  while (at < name.length) {
    const wanted = glob[from];
    if (wanted !== undefined && (wanted === ANY_ONE || wanted === name[at])) {
      from += 1;
      at += 1;
    } else if (wanted === ANY_RUN) {
      star = from;
      resume = at;
      from += 1;
    } else if (star >= 0) {
      from = star + 1;
      resume += 1;
      at = resume;
    } else {
      return false;
    }
  }
  while (glob[from] === ANY_RUN) from += 1;
  return from === glob.length;
}

/** A test for names matching a shell glob (`*`, `?`); null or empty matches everything. */
export function globMatcher(glob: string | null): (name: string) => boolean {
  if (glob === null || glob === "" || glob === ANY_RUN) return () => true;
  const pattern = [...glob];
  return (name) => wildcardMatch(pattern, [...name]);
}

const FILTER_SEPARATOR = /[,\s]+/;

/** The connection's name filter: globs separated by commas or blanks, any one matching; empty lists every name. */
export function nameMatcher(text: string): (name: string) => boolean {
  const matchers = text
    .split(FILTER_SEPARATOR)
    .filter((glob) => glob !== "")
    .map(globMatcher);
  if (matchers.length === 0) return () => true;
  return (name) => matchers.some((matches) => matches(name));
}
