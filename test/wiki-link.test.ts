import { describe, expect, it } from "vitest";
import { extractWikiLinks } from "../src/parsers/wiki-link";

describe("extractWikiLinks", () => {
  it("parses target, alias, fragment", () => {
    const src = "See [[Doc]], [[Doc|alias]], [[Doc#head]], and [[Doc#head|a]].";
    const links = extractWikiLinks(src);
    expect(links).toHaveLength(4);
    expect(links[0]!.rawTarget).toBe("Doc");
    expect(links[1]!.alias).toBe("alias");
    expect(links[2]!.fragment).toBe("head");
  });

  it("skips fenced code", () => {
    const src = "```\n[[Nope]]\n```\n[[Yes]]";
    const links = extractWikiLinks(src);
    expect(links).toHaveLength(1);
    expect(links[0]!.rawTarget).toBe("Yes");
  });

  it("skips inline code", () => {
    const src = "use `[[Nope]]` then [[Yes]]";
    const links = extractWikiLinks(src);
    expect(links.map((l) => l.rawTarget)).toEqual(["Yes"]);
  });
});
