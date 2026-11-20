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
