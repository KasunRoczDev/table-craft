const SPECIAL = /[.+^${}()|[\]\\]/g;

/** A test for names matching a shell glob (`*`, `?`); null or empty matches everything. */
export function globMatcher(glob: string | null): (name: string) => boolean {
  if (glob === null || glob === "" || glob === "*") return () => true;
  const source = glob
    .replace(SPECIAL, (char) => `\\${char}`)
    .replaceAll("*", ".*")
    .replaceAll("?", ".");
  const pattern = new RegExp(`^${source}$`, "u");
  return (name) => pattern.test(name);
}

const FILTER_SEPARATOR = /[,\s]+/;

/** The connection's name filter: globs separated by commas or blanks, any one matching; empty lists every name. */
export function nameFilter(text: string): (name: string) => boolean {
  const matchers = text
    .split(FILTER_SEPARATOR)
    .filter((glob) => glob !== "")
    .map(globMatcher);
  if (matchers.length === 0) return () => true;
  return (name) => matchers.some((matches) => matches(name));
}
