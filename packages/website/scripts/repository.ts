import { githubHeaders, type Fetch } from "./releases.js";
import { REPOSITORY_API_URL } from "./site.js";

/** What the header shows of the repository; without `stars` it shows the GitHub link alone. */
export interface Repository {
  stars?: number;
  error?: string;
}

const STAR_COUNT = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

/** The star count the way GitHub's own button prints it: 999, 1.2K, 12K. */
export function formatStars(stars: number): string {
  return STAR_COUNT.format(stars);
}

/** The repository's star count; a failure leaves it out rather than failing the build. */
export async function fetchRepository(fetchImpl: Fetch, token?: string): Promise<Repository> {
  try {
    const response = await fetchImpl(REPOSITORY_API_URL, { headers: githubHeaders(token) });
    if (!response.ok) return { error: `GitHub answered ${response.status} ${response.statusText}` };
    const { stargazers_count: stars } = (await response.json()) as { stargazers_count?: unknown };
    return typeof stars === "number" ? { stars } : { error: "GitHub sent no stargazers_count" };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
