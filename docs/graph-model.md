# Graph model

Schema version: **1** (export field `schemaVersion`).

## Node identity

Identity-prefixed, workspace-relative, `/`-normalized, case-preserved:

| Prefix | Example | Meaning |
|---|---|---|
| `file:` | `file:docs/architecture.md` | Any file-backed node |
| `dir:` | `dir:packages/api` | Directory |
| `heading:` | `heading:docs/a.md#deploy` | Heading (modeled; view expansion later) |
| `missing:` | `missing:docs/rollback.md` | Resolved path that does not exist |
| `url:` | `url:https://example.com` | External URL |

The prefix is the **identity class**, not the semantic type. Type (`document` vs `instruction`) is an attribute so reclassification does not break edge IDs.

## Edge identity

`{edgeType}|{sourceId}|{targetId}`

Multiple same-type links between the same pair collapse into one edge with `occurrences: SourceRange[]`.

## Node types (MVP)

`document`, `instruction`, `directory`, `source-file`, `external`, `missing`

## Edge types (MVP)

| Type | Meaning |
|---|---|
| `link` | Markdown link between docs |
| `wiki-link` | `[[wiki]]` link |
| `contains` | Directory → child (structural) |
| `references` | Non-doc target, image, `@import` |
| `broken-ref` | Any ref whose target is missing |

## Provenance

Every node/edge carries:

```ts
{
  parserId: string;
  parserVersion: number;
  origin: "explicit" | "inferred";
  confidence: number; // 1.0 for explicit
}
```

Inferred edges (future AI/heuristics) are filtered by default and never commingled with explicit structure.

## Export JSON

```json
{
  "schemaVersion": 1,
  "root": "",
  "nodes": [ /* sorted by id */ ],
  "edges": [ /* sorted by id */ ],
  "generatedAt": ""
}
```

Deterministic: same repository state ⇒ same export bytes (keys sorted, nodes/edges sorted by id).
