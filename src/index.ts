interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * tw-law — Taiwan national statutes and the Constitution, in Chinese plus
 * the Ministry of Justice's own official English translations where one
 * exists, from the Ministry of Justice Laws & Regulations Database
 * (全國法規資料庫). Fleet #3129.
 *
 * The source publishes its whole catalog only as two bulk JSON exports (no
 * per-law or per-article live route — verified 2026-10-15), so this pack
 * reads from a D1 copy loaded and refreshed by scripts/tw-law/load-data.mjs,
 * per Bruce's 2026-09-23 local-copy ruling. See src/store.ts for the licence
 * and the full load path.
 *
 * Every response carries `source` and `data_as_of` (when the load last ran).
 * Every English field is the Ministry's OWN translation, tied to the exact
 * Chinese law/article it translates, and labelled official — never a
 * machine translation.
 */
import {
  type D1Like,
  dataAsOf,
  getArticle,
  getHeadingBefore,
  getLaw,
  getToc,
  requireDb,
  searchLaws,
  shapeLaw,
  SOURCE,
} from './store.js';

const tools: McpToolExport['tools'] = [
  {
    name: 'tw_law_search',
    description:
      'Search Taiwan national statutes and the Constitution by TITLE keyword, Chinese or English — "個人資料保護法", "Personal Data Protection", "民法", "Civil Code". This is a title search, not full-text; it will not find a law by a phrase appearing only inside an article. Returns each match\'s pcode (for tw_law_info/tw_law_article), Chinese and English titles, law level, category, whether an official English translation exists, and the last amendment date. Source: Taiwan Ministry of Justice, Laws & Regulations Database.',
    summary: 'Find a Taiwan law by title (Chinese or English).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Title keyword, Chinese or English, e.g. "個人資料保護法" or "Personal Data Protection Act".' },
        limit: { type: 'number', description: 'Max laws to return (1-50, default 10).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'tw_law_info',
    description:
      'Resolve a Taiwan law to its full metadata by pcode (from tw_law_search) or an exact/partial Chinese or English title — the exact-citation step before reading an article. Returns the law\'s level (法律/憲法), category, official English title if one exists, whether it has been abolished, the LAST AMENDMENT date and the date that amendment TAKES/TOOK LEGAL EFFECT as separate fields (Taiwan statutes can be amended on one date and take effect on another, sometimes "to be set later by the Executive Yuan" — flagged as effective_date_pending), the full promulgation history (in Chinese, and in English when the law has an official translation), and the article count. Source: Taiwan Ministry of Justice, Laws & Regulations Database.',
    summary: "One Taiwan law's metadata: level, category, amendment vs. effective dates, repeal status, promulgation history.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        pcode: { type: 'string', description: 'The law\'s pcode, e.g. "I0050021" (from tw_law_search).' },
        name: { type: 'string', description: 'Chinese or English law title, exact or partial, used when pcode is not known.' },
      },
    },
  },
  {
    name: 'tw_law_toc',
    description:
      'Table of contents for one Taiwan law: its chapter/section headings and the article number of every provision, in order, paged. Use to browse a law\'s structure before reading a specific article with tw_law_article, or to enumerate every article number a long law has. Returns has_more and next_offset when the law has more entries than the page size.',
    summary: "A Taiwan law's chapter structure and article numbers, paged.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        pcode: { type: 'string', description: 'The law\'s pcode (from tw_law_search or tw_law_info).' },
        name: { type: 'string', description: 'Chinese or English law title, used when pcode is not known.' },
        offset: { type: 'number', description: 'Pagination offset (default 0).' },
        limit: { type: 'number', description: 'Max entries to return (1-500, default 200).' },
      },
    },
  },
  {
    name: 'tw_law_article',
    description:
      'Full text of ONE article (條) of a Taiwan law, by pcode or title plus article number in any spelling — "2", "第 2 條", "Article 2", "第 6-1 條", "Article 6-1". Returns the Chinese text and, when the Ministry has published an official English translation of that law, the official English text of the SAME article, labelled official (never a machine translation) — plus the chapter/section heading it falls under. A long law is never returned whole; use tw_law_toc to find article numbers, and call this once per article.',
    summary: 'One article of a Taiwan law, Chinese plus the official English translation when one exists.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        pcode: { type: 'string', description: 'The law\'s pcode (from tw_law_search or tw_law_info).' },
        name: { type: 'string', description: 'Chinese or English law title, used when pcode is not known.' },
        article: { type: 'string', description: 'Article number, any spelling: "2", "第 2 條", "Article 2", "6-1".' },
      },
      required: ['article'],
    },
  },
];

function clamp(v: unknown, lo: number, hi: number, d: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : d;
}

async function resolvePcode(db: D1Like, args: Record<string, unknown>): Promise<string> {
  const pcode = args.pcode != null ? String(args.pcode).trim() : '';
  const name = args.name != null ? String(args.name).trim() : '';
  if (!pcode && !name) throw new Error('Provide either "pcode" (from tw_law_search) or "name" (a Chinese or English law title).');
  const law = await getLaw(db, { pcode: pcode || undefined, name: name || undefined });
  if (!law) throw new Error(`No Taiwan law found for ${pcode ? `pcode "${pcode}"` : `name "${name}"`}. Try tw_law_search first.`);
  return law.pcode;
}

async function searchTool(db: D1Like, args: Record<string, unknown>) {
  const query = String(args.query ?? '').trim();
  if (!query) throw new Error('Required argument "query" is missing (a Chinese or English law title keyword).');
  const limit = clamp(args.limit, 1, 50, 10);
  const rows = await searchLaws(db, { query, limit });
  return {
    query,
    returned: rows.length,
    laws: rows.map((r) => ({ ...shapeLaw(r), matched_on: r.matched_on })),
    note: rows.length === 0 ? 'No law title matched. This is a title search — try tw_law_search with a different keyword, not an article phrase.' : undefined,
    source: SOURCE,
    data_as_of: await dataAsOf(db),
  };
}

async function infoTool(db: D1Like, args: Record<string, unknown>) {
  const pcode = args.pcode != null ? String(args.pcode).trim() : '';
  const name = args.name != null ? String(args.name).trim() : '';
  if (!pcode && !name) throw new Error('Provide either "pcode" (from tw_law_search) or "name" (a Chinese or English law title).');
  const law = await getLaw(db, { pcode: pcode || undefined, name: name || undefined });
  if (!law) throw new Error(`No Taiwan law found for ${pcode ? `pcode "${pcode}"` : `name "${name}"`}. Try tw_law_search first.`);
  return { ...shapeLaw(law), data_as_of: await dataAsOf(db) };
}

async function tocTool(db: D1Like, args: Record<string, unknown>) {
  const pcode = await resolvePcode(db, args);
  const offset = clamp(args.offset, 0, 1_000_000, 0);
  const limit = clamp(args.limit, 1, 500, 200);
  const { rows, total } = await getToc(db, { pcode, offset, limit });
  return {
    pcode,
    total_entries: total,
    returned: rows.length,
    offset,
    entries: rows.map((r) => ({
      seq: r.seq,
      kind: r.article_type === 'C' ? 'heading' : 'article',
      article_no: r.article_no || null,
      eng_article_no: r.eng_article_no || null,
      text: r.article_type === 'C' ? r.content : undefined,
    })),
    has_more: offset + rows.length < total,
    next_offset: offset + rows.length < total ? offset + rows.length : null,
    source: SOURCE,
    data_as_of: await dataAsOf(db),
  };
}

async function articleTool(db: D1Like, args: Record<string, unknown>) {
  const articleArg = args.article != null ? String(args.article).trim() : '';
  if (!articleArg) throw new Error('Required argument "article" is missing, e.g. "2" or "Article 2".');
  const pcode = await resolvePcode(db, args);
  const row = await getArticle(db, { pcode, articleNo: articleArg });
  if (!row) {
    throw new Error(
      `No article "${articleArg}" found for this law. Use tw_law_toc to list its real article numbers — some laws skip numbers or use "-1"/"-2" sub-articles.`,
    );
  }
  const law = await getLaw(db, { pcode });
  const heading = await getHeadingBefore(db, { pcode, seq: row.seq });
  return {
    pcode,
    law_name: law?.law_name ?? null,
    eng_law_name: law?.eng_law_name ?? null,
    heading: heading,
    article_no: row.article_no,
    content: row.content,
    eng_article_no: row.eng_article_no,
    eng_content: row.eng_content,
    translation_label: row.eng_content ? 'official' : null,
    has_official_english_translation: !!row.eng_content,
    source: SOURCE,
    data_as_of: await dataAsOf(db),
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const db = requireDb(args._d1);
  switch (name) {
    case 'tw_law_search':
      return searchTool(db, args);
    case 'tw_law_info':
      return infoTool(db, args);
    case 'tw_law_toc':
      return tocTool(db, args);
    case 'tw_law_article':
      return articleTool(db, args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
