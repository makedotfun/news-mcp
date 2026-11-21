// World news search over the GDELT Project's free DOC 2.0 API (https://api.gdeltproject.org/api/v2/doc/doc).
// GDELT asks for at most one request every five seconds, so every call here goes through one shared pacer.

import { USER_AGENT, type FetchLike } from './api.ts';

export const GDELT_ENDPOINT = 'https://api.gdeltproject.org/api/v2/doc/doc';
export const GDELT_LABEL = 'from GDELT, not curated';
/** GDELT's own pace: one request per five seconds. */
export const GDELT_MIN_INTERVAL_MS = 5_000;
export const GDELT_MAX_RECORDS = 250;
const TIMEOUT_MS = 30_000;

/** A GDELT timespan: minutes (min), hours (h), days (d), weeks (w) or months (m), at least 15 minutes, at most 3 months. */
export const TIMESPAN_RE = /^(\d{1,4})(min|mins|minutes|h|hours|d|days|w|weeks|m|months)$/;

export interface GdeltArticle {
  title: string;
  url: string;
  domain: string;
  language: string;
  sourceCountry: string;
  /** When GDELT first saw the article, ISO 8601 UTC. */
  seenAt: string | null;
  image: string | null;
}

export interface GdeltSearch {
  query: string;
  timespan?: string;
  maxRecords?: number;
  sourceCountry?: string;
  sourceLang?: string;
}

export interface GdeltResult {
  /** The query as sent to GDELT, operators included. */
  query: string;
  timespan: string;
  articles: GdeltArticle[];
}

export class GdeltError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'GdeltError';
    this.status = status;
  }
}

/** Minutes a GDELT timespan covers, or null when it is not one. */
export function timespanMinutes(span: string): number | null {
  const m = TIMESPAN_RE.exec(span.trim().toLowerCase());
  if (m === null) return null;
  const n = Number(m[1]);
  const unit = m[2] ?? '';
  if (unit.startsWith('min')) return n;
  if (unit.startsWith('h')) return n * 60;
  if (unit.startsWith('d')) return n * 1440;
  if (unit.startsWith('w')) return n * 10080;
  return n * 43200;
}

/** Whether GDELT accepts `span`: 15 minutes up to 3 months. */
export function isValidTimespan(span: string): boolean {
  const minutes = timespanMinutes(span);
  return minutes !== null && minutes >= 15 && minutes <= 3 * 43200;
}

/** GDELT's seendate (20261121T064500Z) as ISO 8601. */
export function seenDateIso(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  if (m === null) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

/** A country or language for GDELT's operators: lowercase, spaces dropped ("United Arab Emirates" → unitedarabemirates). */
function operatorValue(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The full GDELT query: the caller's words, then sourcecountry: and sourcelang: when given. */
export function gdeltQuery(s: Pick<GdeltSearch, 'query' | 'sourceCountry' | 'sourceLang'>): string {
  const parts = [s.query.trim()];
  if (s.sourceCountry !== undefined && operatorValue(s.sourceCountry) !== '') parts.push(`sourcecountry:${operatorValue(s.sourceCountry)}`);
  if (s.sourceLang !== undefined && operatorValue(s.sourceLang) !== '') parts.push(`sourcelang:${operatorValue(s.sourceLang)}`);
  return parts.join(' ');
}

/** GDELT's JSON, which now and then carries raw control characters inside its strings. */
export function parseGdeltJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(text.replace(/[\u0000-\u001f]/g, ' '));
  }
}

export function articlesOf(body: unknown): GdeltArticle[] {
  if (body === null || typeof body !== 'object') return [];
  const raw = (body as { articles?: unknown }).articles;
  if (!Array.isArray(raw)) return [];
  const out: GdeltArticle[] = [];
  for (const a of raw) {
    if (a === null || typeof a !== 'object') continue;
    const r = a as Record<string, unknown>;
    if (typeof r.url !== 'string' || !/^https?:\/\//.test(r.url)) continue;
    out.push({
      title: typeof r.title === 'string' && r.title.trim() !== '' ? r.title.trim() : r.url,
      url: r.url,
      domain: typeof r.domain === 'string' ? r.domain : new URL(r.url).hostname,
      language: typeof r.language === 'string' ? r.language : '',
      sourceCountry: typeof r.sourcecountry === 'string' ? r.sourcecountry : '',
      seenAt: seenDateIso(r.seendate),
      image: typeof r.socialimage === 'string' && /^https?:\/\//.test(r.socialimage) ? r.socialimage : null,
    });
  }
  return out;
}

/**
 * Serializes calls so that each one starts at least `intervalMs` after the previous one did. One pacer is shared by
 * every server instance in the process (the HTTP mode builds a server per request).
 */
export class Pacer {
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private last = Number.NEGATIVE_INFINITY;
  private tail: Promise<void> = Promise.resolve();

  constructor(intervalMs: number, clock: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
    this.intervalMs = intervalMs;
    this.now = clock.now ?? (() => Date.now());
    this.sleep = clock.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Runs `fn` once every earlier call has finished and `intervalMs` has passed since the last one ended. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const turn = this.tail.then(async () => {
      const wait = this.last + this.intervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
      try {
        return await fn();
      } finally {
        this.last = Math.max(this.last, this.now());
      }
    });
    this.tail = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  }

  /** Pushes the next start out by `ms` from now (after a 429). */
  backOff(ms: number): void {
    this.last = Math.max(this.last, this.now() + ms - this.intervalMs);
  }
}

export interface GdeltClientOptions {
  fetch?: FetchLike;
  pacer?: Pacer;
  /** How many times a 429 is retried (each after the pacer's next slot plus a short back-off). Default 2. */
  retries?: number;
  /** Extra wait after a 429 before the next try. Default 6 s. */
  backOffMs?: number;
  endpoint?: string;
}

export class GdeltClient {
  private readonly fetchImpl: FetchLike;
  private readonly pacer: Pacer;
  private readonly retries: number;
  private readonly backOffMs: number;
  private readonly endpoint: string;

  constructor(opts: GdeltClientOptions = {}) {
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.pacer = opts.pacer ?? new Pacer(GDELT_MIN_INTERVAL_MS);
    this.retries = opts.retries ?? 2;
    this.backOffMs = opts.backOffMs ?? 6_000;
    this.endpoint = opts.endpoint ?? GDELT_ENDPOINT;
  }

  /** The request URL for a search (mode=artlist, format=json). */
  urlOf(s: GdeltSearch): string {
    const timespan = (s.timespan ?? '24h').trim().toLowerCase();
    const sp = new URLSearchParams({
      query: gdeltQuery(s),
      mode: 'artlist',
      format: 'json',
      maxrecords: String(Math.min(GDELT_MAX_RECORDS, Math.max(1, s.maxRecords ?? 25))),
      timespan,
      sort: 'hybridrel',
    });
    return `${this.endpoint}?${sp.toString()}`;
  }

  async search(s: GdeltSearch): Promise<GdeltResult> {
    const timespan = (s.timespan ?? '24h').trim().toLowerCase();
    if (!isValidTimespan(timespan)) throw new GdeltError(`timespan "${s.timespan}" is not one GDELT takes: use a number and a unit, min, h, d, w or m (months), from 15min to 3m, e.g. 24h, 3d, 1w.`, 400);
    const url = this.urlOf({ ...s, timespan });
    for (let attempt = 0; ; attempt++) {
      const res = await this.pacer.run(() => this.fetchOnce(url));
      if (res.status === 429) {
        if (attempt < this.retries) {
          this.pacer.backOff(this.backOffMs);
          continue;
        }
        throw new GdeltError('GDELT is rate limiting requests from this address (it asks for one request every 5 seconds). Try again in a minute.', 429);
      }
      if (res.status !== 200) throw new GdeltError(`GDELT answered ${res.status}${res.text === '' ? '' : ` (${firstLine(res.text)})`}.`, res.status);
      const trimmed = res.text.trim();
      if (trimmed === '') return { query: gdeltQuery(s), timespan, articles: [] };
      if (!trimmed.startsWith('{')) throw new GdeltError(`GDELT refused the query: ${firstLine(trimmed)}`, 400);
      let body: unknown;
      try {
        body = parseGdeltJson(trimmed);
      } catch {
        throw new GdeltError('GDELT answered JSON this server could not read.', 502);
      }
      return { query: gdeltQuery(s), timespan, articles: articlesOf(body) };
    }
  }

  private async fetchOnce(url: string): Promise<{ status: number; text: string }> {
    try {
      const res = await this.fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      return { status: res.status, text: await res.text() };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new GdeltError(`Could not reach GDELT (${reason}).`, 0);
    }
  }
}

function firstLine(s: string): string {
  return (s.trim().split('\n')[0] ?? '').slice(0, 300);
}
