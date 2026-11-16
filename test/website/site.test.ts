import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SITE_URL } from "../../packages/website/scripts/site.js";

const RELEASING = "RELEASING.md";
const WEBSITE_WORKFLOW = ".github/workflows/website.yml";

describe("site URL", () => {
  it("givenSiteUrl_whenComparedWithReleasingAndTheWorkflow_thenTheyNameTheSameDomain", () => {
    const domain = new URL(SITE_URL).host;

    expect(readFileSync(RELEASING, "utf8")).toContain(`<${SITE_URL}/>`);
    expect(readFileSync(RELEASING, "utf8")).toContain(`is \`${domain}\``);
    expect(readFileSync(WEBSITE_WORKFLOW, "utf8")).toContain(`${SITE_URL}/`);
  });
});
