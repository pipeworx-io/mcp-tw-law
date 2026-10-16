/**
 * Reads for tw-law (fleet #3129).
 *
 * Taiwan's Ministry of Justice Laws & Regulations Database
 * (全國法規資料庫, law.moj.gov.tw) publishes its whole catalog — every national
 * statute and the Constitution, in Chinese, plus the Ministry's own official
 * English translations where one exists — only as two bulk JSON exports (one
 * per language), never a per-law or per-article live route (verified
 * 2026-10-15: both `/api/Ch/Law/JSON` and `/api/En/Law/JSON` return a zip of
 * the ENTIRE catalog; there is no `LawSearchContent`-style per-item endpoint).
 * Per Bruce's 2026-09-23 ruling on bulk-only sources, `scripts/tw-law/load-data.mjs`
 * downloads both exports, joins each Chinese law to its official English
 * translation by title (the join key the source itself uses — see that
 * script's header), and writes the result into a D1 database the gateway
 * hands this pack as `_d1`
 * (pack-manifest "d1Binding": "TW_LAW_DB"). Table/column names here must
 * match that script's buildSchemaSql().
 *
 * Licence: 政府資料開放授權條款-第1版 (Government Open Data Licence v1), the
 * licence law.moj.gov.tw's own data-reuse declaration
 * (law.moj.gov.tw/Service/Copyright.aspx) names for this database — free,
 * non-exclusive, re-licensable, and explicitly permits reproduction,
 * adaptation and public transmission (i.e. a mirror, not just a live proxy),
 * conditioned only on citing the source. That is what is cited below.
 */

/** The slice of Cloudflare's D1Database this pack uses, declared here so the
 *  pack needs no workers-types and a test can pass a node:sqlite stub. */
export interface D1Like {
  prepare(sql: string): D1StmtLike;
}
export interface D1StmtLike {
  bind(...values: unknown[]): D1StmtLike;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

// Provenance is publisher + dataset + data_as_of (CLAUDE.md step 9b) — never
// the download route.
export const SOURCE = 'Taiwan Ministry of Justice, Laws & Regulations Database (全國法規資料庫)';
export const LICENSE =
  '政府資料開放授權條款-第1版 (Government Open Data Licence v1) — free, non-exclusive, ' +
  're-licensable reuse including reproduction and public transmission, conditioned on citing the source.';

export class StoreUnavailableError extends Error {
  constructor() {
    super(
      'tw-law: the law store is not bound in this runtime (no _d1). These tools only answer through the Pipeworx gateway; a standalone install has no data to read.',
    );
    this.name = 'StoreUnavailableError';
  }
}
export function requireDb(d1: unknown): D1Like {
  if (!d1 || typeof (d1 as D1Like).prepare !== 'function') throw new StoreUnavailableError();
  return d1 as D1Like;
}

export interface LawRow {
  pcode: string;
  law_name: string;
  eng_law_name: string | null;
  law_level: string;
  law_category: string | null;
  law_url: string;
  eng_law_url: string | null;
  has_eng_version: number;
  modified_date: string | null;
  effective_date: string | null;
  effective_note: string | null;
  abandon_note: string | null;
  foreword: string | null;
  histories: string | null;
  eng_histories: string | null;
  article_count: number;
}

const LAW_COLS = `pcode, law_name, eng_law_name, law_level, law_category, law_url, eng_law_url, has_eng_version,
  modified_date, effective_date, effective_note, abandon_note, foreword, histories, eng_histories, article_count`;

/** Chinese government dates are plain YYYYMMDD strings; a few historical
 *  entries are empty (effective on promulgation) or the "99991231" sentinel
 *  the source itself uses for "date set later by the Executive Yuan" — never
 *  guess a real date for either, surface them as given. */
function fmtDate(raw: string | null): string | null {
  if (!raw) return null;
  if (raw === '99991231') return null;
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : raw;
}

function isPending(raw: string | null): boolean {
  return raw === '99991231';
}

export function shapeLaw(r: LawRow) {
  return {
    pcode: r.pcode,
    law_name: r.law_name,
    eng_law_name: r.eng_law_name,
    law_level: r.law_level,
    law_category: r.law_category,
    law_url: r.law_url,
    eng_law_url: r.eng_law_url,
    has_official_english_translation: r.has_eng_version === 1,
    abolished: !!(r.abandon_note && r.abandon_note.trim()),
    abandon_note: r.abandon_note || null,
    // Dates kept apart per the legal-pack contract: amendment date (most
    // recent change to the text) vs. the date that amendment takes/took
    // legal effect — the source tracks these as two separate fields, and so
    // does this pack.
    last_amended_date: fmtDate(r.modified_date),
    effective_date: fmtDate(r.effective_date),
    effective_date_pending: isPending(r.effective_date),
    effective_note: r.effective_note || null,
    foreword: r.foreword || null,
    promulgation_history: r.histories || null,
    promulgation_history_english: r.eng_histories || null,
    article_count: r.article_count,
    source: SOURCE,
  };
}

export async function dataAsOf(db: D1Like): Promise<string | null> {
  const r = await db.prepare(`SELECT value FROM tw_law_meta WHERE key = 'loaded_at'`).first<{ value: string }>();
  return r?.value ?? null;
}

/** The whole catalog is 1,351 laws — a LIKE scan over that is trivial, so
 *  title search skips FTS5 entirely (and the chunked-import trap that comes
 *  with it; see reference_d1_fts5_import_trap) in favor of a plain
 *  substring match on both the Chinese and English titles. */
export async function searchLaws(
  db: D1Like,
  opts: { query: string; limit: number },
): Promise<Array<LawRow & { matched_on: 'chinese_title' | 'english_title' }>> {
  const q = opts.query.trim();
  if (!q) return [];
  const cols = LAW_COLS.split(',').map((c) => `l.${c.trim()}`).join(', ');
  const r = await db
    .prepare(
      `SELECT ${cols},
         CASE WHEN l.law_name LIKE ? THEN 'chinese_title' ELSE 'english_title' END AS matched_on
       FROM tw_laws l WHERE l.law_name LIKE ? OR l.eng_law_name LIKE ?
       ORDER BY length(l.law_name) LIMIT ?`,
    )
    .bind(`%${q}%`, `%${q}%`, `%${q}%`, opts.limit)
    .all<LawRow & { matched_on: 'chinese_title' | 'english_title' }>();
  return r.results;
}

export async function getLaw(db: D1Like, opts: { pcode?: string; name?: string }): Promise<LawRow | null> {
  if (opts.pcode) {
    return db.prepare(`SELECT ${LAW_COLS} FROM tw_laws WHERE pcode = ?`).bind(opts.pcode).first<LawRow>();
  }
  if (opts.name) {
    const exact = await db.prepare(`SELECT ${LAW_COLS} FROM tw_laws WHERE law_name = ? OR eng_law_name = ?`).bind(opts.name, opts.name).first<LawRow>();
    if (exact) return exact;
    return db
      .prepare(`SELECT ${LAW_COLS} FROM tw_laws WHERE law_name LIKE ? OR eng_law_name LIKE ? ORDER BY length(law_name) LIMIT 1`)
      .bind(`%${opts.name}%`, `%${opts.name}%`)
      .first<LawRow>();
  }
  return null;
}

export interface ArticleRow {
  seq: number;
  article_type: 'A' | 'C';
  article_no: string | null;
  article_no_norm: string | null;
  content: string;
  eng_article_no: string | null;
  eng_content: string | null;
}
const ARTICLE_COLS = 'seq, article_type, article_no, article_no_norm, content, eng_article_no, eng_content';

export async function getToc(
  db: D1Like,
  opts: { pcode: string; offset: number; limit: number },
): Promise<{ rows: ArticleRow[]; total: number }> {
  const total = await db.prepare(`SELECT count(*) AS n FROM tw_articles WHERE pcode = ?`).bind(opts.pcode).first<{ n: number }>();
  const r = await db
    .prepare(`SELECT ${ARTICLE_COLS} FROM tw_articles WHERE pcode = ? ORDER BY seq LIMIT ? OFFSET ?`)
    .bind(opts.pcode, opts.limit, opts.offset)
    .all<ArticleRow>();
  return { rows: r.results, total: total?.n ?? 0 };
}

/** "第 2 條" / "2" / "Article 2" / "第 6-1 條" / "Article 6-1" all normalize
 *  to the same key the loader stored, so any of the source's own spellings
 *  (Chinese or English) resolves a provision. */
export function normalizeArticleNo(v: string): string {
  const m = /(\d+)(?:[-之](\d+))?/.exec(String(v));
  if (!m) return String(v).trim();
  return m[2] ? `${m[1]}-${m[2]}` : m[1];
}

export async function getArticle(db: D1Like, opts: { pcode: string; articleNo: string }): Promise<ArticleRow | null> {
  const norm = normalizeArticleNo(opts.articleNo);
  return db
    .prepare(`SELECT ${ARTICLE_COLS} FROM tw_articles WHERE pcode = ? AND article_type = 'A' AND article_no_norm = ? LIMIT 1`)
    .bind(opts.pcode, norm)
    .first<ArticleRow>();
}

/** The chapter/section heading (ArticleType 'C') immediately preceding a
 *  given seq, for context — "第 一 章 總則" above Article 1, etc. */
export async function getHeadingBefore(db: D1Like, opts: { pcode: string; seq: number }): Promise<string | null> {
  const r = await db
    .prepare(`SELECT content FROM tw_articles WHERE pcode = ? AND article_type = 'C' AND seq < ? ORDER BY seq DESC LIMIT 1`)
    .bind(opts.pcode, opts.seq)
    .first<{ content: string }>();
  return r?.content ?? null;
}
