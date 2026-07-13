import GithubSlugger from "github-slugger";

/** Build a GitHub-style heading slug table (with -1/-2 dedupe). */
export function buildSlugTable(headings: string[]): Map<string, string> {
  const slugger = new GithubSlugger();
  const table = new Map<string, string>();
  for (const h of headings) {
    const slug = slugger.slug(h);
    // Map both the raw heading text key and the slug for lookup
    table.set(slug, h);
  }
  return table;
}

export function slugifyHeadings(headings: string[]): string[] {
  const slugger = new GithubSlugger();
  return headings.map((h) => slugger.slug(h));
}

export function makeSlugger(): GithubSlugger {
  return new GithubSlugger();
}
