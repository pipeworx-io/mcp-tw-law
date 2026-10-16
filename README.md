# @pipeworx/tw-law

Taiwan's national statutes and the Constitution — full text in Chinese, plus
the Ministry of Justice's own official English translation where one exists
— searchable by title, resolvable by exact citation, and readable one
provision at a time.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1815+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `tw_law_search(query, limit?)` — find a law by title keyword, Chinese or
  English ("個人資料保護法", "Personal Data Protection", "民法").
- `tw_law_info(pcode?, name?)` — a law's full metadata: level, category,
  official English title if any, repeal status, the last amendment date and
  the date that amendment takes/took legal effect as SEPARATE fields, and
  the promulgation history (Chinese, and English when translated).
- `tw_law_toc(pcode?, name?, offset?, limit?)` — a law's chapter/section
  structure and article numbers, paged.
- `tw_law_article(pcode?, name?, article)` — one article's full text,
  Chinese plus the official English translation when the Ministry has
  published one, labelled `official`.

## Auth

Keyless.

## Data sources

- Taiwan Ministry of Justice, Laws & Regulations Database (全國法規資料庫) —
  the Chinese text of every national statute and the Constitution, plus the
  Ministry's own official English translations for the subset it has
  translated (973 of 1,351 laws as of the 2026-10-15 load).

The source publishes its whole catalog only as two bulk exports (Chinese,
English), never a per-law or per-article live route — confirmed 2026-10-15.
Per Bruce's 2026-09-23 local-copy ruling, this pack reads from a D1 copy
loaded by `scripts/tw-law/load-data.mjs`, refreshed by re-running that
script. `data_as_of` on every response is when that load last ran.

**Licence:** 政府資料開放授權條款-第1版 (Government Open Data Licence v1), the
licence the source's own data-reuse declaration
(law.moj.gov.tw/Service/Copyright.aspx) names — free, non-exclusive,
re-licensable, and explicitly permits reproduction, adaptation and public
transmission (a mirror, not only a live proxy), conditioned on citing the
source. Every response carries `source`.

## English translations are tied to the exact Chinese version

Chinese and English are two separate bulk exports from the same publisher,
joined by this pack's loader at load time, by law title and then by article
number (normalizing "第 6-1 條" / "Article 6-1" / "6-1" to the same key) —
never machine-translated, never guessed. An article with no official
translation returns `eng_content: null` and
`has_official_english_translation: false` rather than a translation that
doesn't exist. A law can gain or lose an official translation between loads;
`tw_law_info`/`tw_law_search` report `has_official_english_translation` as of
the current `data_as_of`.

## Notes

- `tw_law_search` is a TITLE search — it will not find a law by a phrase that
  appears only inside an article's text.
- Article numbering is not always contiguous: amendments can delete an
  article or insert a sub-article ("第 1-1 條" after "第 1 條"). Use
  `tw_law_toc` to see a law's real article numbers rather than assuming
  1..N.
- `effective_date` and `last_amended_date` are tracked separately because
  Taiwanese statutes are routinely amended on one date and brought into
  force on another (sometimes "date to be set later by the Executive Yuan"
  — surfaced as `effective_date_pending: true`, with the full
  `effective_note` explaining which provisions are affected).

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "tw-law": {
      "url": "https://gateway.pipeworx.io/tw-law/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/tw-law/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1815+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/tw_law_search \
  -H 'Content-Type: application/json' \
  -d '{"query":"個人資料保護法"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/tw_law_search`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "tw-law": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-tw-law"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-tw-law
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Tw Law data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
