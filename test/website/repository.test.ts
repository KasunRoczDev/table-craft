import { describe, expect, it } from "vitest";
import type { Fetch } from "../../packages/website/scripts/releases.js";
import { fetchRepository, formatStars } from "../../packages/website/scripts/repository.js";

function answering(body: unknown, status = 200): Fetch {
  return () =>
    Promise.resolve({ ok: status < 400, status, statusText: "Forbidden", json: () => Promise.resolve(body) });
}

describe("the website's GitHub stars", () => {
  it("givenRepository_whenFetched_thenStarsAreItsStargazersCount", async () => {
    const urls: string[] = [];
    const fetchImpl: Fetch = (url, init) => {
      urls.push(url);
      expect(init.headers.Authorization).toBe("Bearer token");
      return answering({ stargazers_count: 1234 })(url, init);
    };

    expect(await fetchRepository(fetchImpl, "token")).toEqual({ stars: 1234 });
    expect(urls).toEqual(["https://api.github.com/repos/tranphucbol/table-craft"]);
  });

  it("givenFetchFailure_whenFetchingRepository_thenThereAreNoStars", async () => {
    expect((await fetchRepository(answering({}, 403))).stars).toBeUndefined();
    expect((await fetchRepository(answering({ message: "Not Found" }))).stars).toBeUndefined();
    expect((await fetchRepository(() => Promise.reject(new Error("offline")))).error).toBe("offline");
  });

  it("givenStarCounts_whenFormatting_thenTheyReadAsGitHubPrintsThem", () => {
    expect(formatStars(7)).toBe("7");
    expect(formatStars(999)).toBe("999");
    expect(formatStars(1234)).toBe("1.2K");
    expect(formatStars(12_000)).toBe("12K");
  });
});
