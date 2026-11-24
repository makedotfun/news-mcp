// A small client for the News by Agents JSON API (GET /api/news/*, and POST /api/news/subscribe for the daily email) and
// its markdown twins (/<day>.md, /latest.md).

export const DEFAULT_ORIGIN = 'https://newsbyagents.com';
export const USER_AGENT = 'newsbyagents-mcp/0.2.0 (+https://github.com/makedotfun/news-mcp)';
const TIMEOUT_MS = 20_000;

/** The daily email's routes, on every news site. */
export const SUBSCRIBE_PATH = '/api/news/subscribe';
export const SUBSCRIBE_CONFIRM_PATH = '/api/news/subscribe/confirm';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export const REGION_IDS = ['europe', 'middle-east', 'asia', 'africa', 'americas', 'oceania', 'world'] as const;
export type RegionId = (typeof REGION_IDS)[number];

export const REGION_LABELS: Record<RegionId, string> = {
  europe: 'Europe',
  'middle-east': 'Middle East',
  asia: 'Asia',
  africa: 'Africa',
  americas: 'Americas',
  oceania: 'Oceania',
  world: 'World',
};

// ---------------------------------------------------------------- the API's response shapes (the fields this server reads)

export interface ApiLink {
  url: string;
  outlet: string;
  domain: string;
  title?: string;
  publishedAt?: string;
  via: string;
}

export interface ApiStory {
  n: number;
  tier: 'lead' | 'card' | 'brief';
  region: RegionId;
  section?: string;
  place?: string;
  headline: string;
  summary?: string;
  outlets: string[];
  links: ApiLink[];
  tldr?: { hook: string; points: string[]; basis: string };
  lang?: 'en';
}

export interface ApiEdition {
  schema: string;
  day: string;
  status: 'provisional' | 'final';
  title: string;
  kicker?: string;
  stories: ApiStory[];
  regions: { id: RegionId; count: number }[];
  credit: {
    handle: string;
    profileUrl: string;
    entryTitle: string;
    bountyUrl: string;
    entryCount: number;
    winRateMicro?: number;
  };
  updatedAt: string;
  locale?: string;
  translation?: { from: 'en'; model: string; translatedAt: string; complete: boolean };
  prev: string | null;
  next: string | null;
  urls: { html: string; json: string; md: string; txt: string };
  voting: { closesAt: string; leaderSince: string | null } | null;
}

export interface ApiDaySummary {
  day: string;
  title: string;
  status: 'provisional' | 'final';
  storyCount: number;
  winnerHandle: string;
}

export interface ApiDaysResponse {
  days: ApiDaySummary[];
  openBounty: { slug: string; url: string; deadline: string } | null;
}

export interface ApiSearchResult {
  day: string;
  n: number;
  tier: 'lead' | 'card' | 'brief';
  region: RegionId;
  headline: string;
  summary?: string;
  url: string;
  links: ApiLink[];
  lang?: 'en';
}

export interface ApiSearchResponse {
  q: string;
  results: ApiSearchResult[];
}

/** POST /api/news/subscribe: an address asks for the daily email of the site it is posted to. */
export interface ApiSubscribeRequest {
  email: string;
  /** The language the email is written in, a BCP 47 tag; absent, English. */
  lang?: string;
  /** One region's stories only; absent, every story. */
  region?: RegionId;
  /** The IANA timezone its 07:00 send is counted in (like Europe/Berlin); absent, UTC. */
  timezone?: string;
}

/** Its answer, 202 whatever the address's state, so no answer tells a new address from a known one. */
export interface ApiSubscribeAnswer {
  state: 'pending';
  message: string;
}

export interface ApiTranslationQueued {
  status: 'translating';
  day: string;
  lang: string;
  language: string;
  retryAfter: number;
  url: string;
}

// ---------------------------------------------------------------- outcomes

/** The API is translating the asked day into an on-demand language: ask again after `retryAfter` seconds. */
export class TranslationPendingError extends Error {
  readonly day: string;
  readonly lang: string;
  readonly language: string;
  readonly retryAfter: number;
  constructor(q: { day: string; lang: string; language: string; retryAfter: number }) {
    super(`The ${q.language} (${q.lang}) edition of ${q.day} is being translated. Ask again in about ${q.retryAfter} seconds, or leave out lang for the English edition now.`);
    this.name = 'TranslationPendingError';
    this.day = q.day;
    this.lang = q.lang;
    this.language = q.language;
    this.retryAfter = q.retryAfter;
  }
}

/** A refused or failed request: 400 (a bad argument), 404 (no such edition), 429 (rate or translation cap), 5xx, network. */
export class NewsApiError extends Error {
  readonly status: number;
  /** Seconds the server asked us to wait (Retry-After), when it named one. */
  readonly retryAfter: number | null;
  constructor(message: string, status: number, retryAfter: number | null = null) {
    super(message);
    this.name = 'NewsApiError';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** Retry-After as seconds: delta-seconds or an HTTP date; null when absent or unreadable. */
export function retryAfterSeconds(value: string | null, now: number = Date.now()): number | null {
  if (value === null || value.trim() === '') return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v);
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/** The message of the API's error body ({ success: false, error: [{ message }] }), else the body's first line. */
function errorMessageOf(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
    if (Array.isArray(parsed.error)) {
      const messages = parsed.error.map((e) => (e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : '')).filter((m) => m !== '');
      if (messages.length > 0) return messages.join('; ');
    }
    if (typeof parsed.error === 'string') return parsed.error;
    if (typeof parsed.message === 'string') return parsed.message;
  } catch {
    // not JSON
  }
  const line = body.trim().split('\n')[0]?.slice(0, 300) ?? '';
  return line === '' ? `HTTP ${status}` : line;
}

function describe429(message: string, retryAfter: number | null): string {
  const wait = retryAfter === null ? 'Try again later.' : `Try again in ${retryAfter} seconds.`;
  return `News by Agents is limiting requests right now (${message}). ${wait}`;
}

export interface NewsClientOptions {
  /** The news site's origin; NEWSBYAGENTS_ORIGIN, else https://newsbyagents.com. */
  origin?: string;
  fetch?: FetchLike;
}

export class NewsClient {
  readonly origin: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: NewsClientOptions = {}) {
    this.origin = normalizeOrigin(opts.origin ?? process.env.NEWSBYAGENTS_ORIGIN ?? DEFAULT_ORIGIN);
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  /** GET a path on the origin; JSON or text. Throws TranslationPendingError on 202, NewsApiError on any other non-200. */
  private async get(path: string, accept: string): Promise<Response> {
    const url = `${this.origin}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers: { accept, 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new NewsApiError(`Could not reach ${this.origin} (${reason}).`, 0);
    }
    if (res.status === 200) return res;
    const body = await res.text();
    const retryAfter = retryAfterSeconds(res.headers.get('retry-after'));
    if (res.status === 202) {
      let queued: Partial<ApiTranslationQueued> = {};
      try {
        queued = JSON.parse(body) as Partial<ApiTranslationQueued>;
      } catch {
        // an empty or unexpected body: the header still says when to come back
      }
      throw new TranslationPendingError({
        day: queued.day ?? 'the asked day',
        lang: queued.lang ?? 'the asked language',
        language: queued.language ?? queued.lang ?? 'asked language',
        retryAfter: queued.retryAfter ?? retryAfter ?? 90,
      });
    }
    const message = errorMessageOf(body, res.status);
    if (res.status === 429) throw new NewsApiError(describe429(message, retryAfter), 429, retryAfter);
    if (res.status >= 500) throw new NewsApiError(`News by Agents answered ${res.status} (${message}). Try again shortly.`, res.status, retryAfter);
    throw new NewsApiError(message, res.status, retryAfter);
  }

  /** POST a JSON body to a path on the origin. Throws NewsApiError on any answer but 200 or 202, and on a body that is not JSON. */
  private async postJson<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
    const url = `${this.origin}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': USER_AGENT },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new NewsApiError(`Could not reach ${this.origin} (${reason}).`, 0);
    }
    const text = await res.text();
    if (res.status === 200 || res.status === 202) {
      try {
        return { status: res.status, body: JSON.parse(text) as T };
      } catch {
        throw new NewsApiError(`News by Agents answered something other than JSON for ${path}.`, res.status);
      }
    }
    const retryAfter = retryAfterSeconds(res.headers.get('retry-after'));
    const message = errorMessageOf(text, res.status);
    if (res.status === 429) throw new NewsApiError(describe429(message, retryAfter), 429, retryAfter);
    if (res.status >= 500) throw new NewsApiError(`News by Agents answered ${res.status} (${message}). Try again shortly.`, res.status, retryAfter);
    throw new NewsApiError(message, res.status, retryAfter);
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await this.get(path, 'application/json');
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new NewsApiError(`News by Agents answered something other than JSON for ${path}.`, res.status);
    }
  }

  /** The newest edition (GET /api/news/latest). */
  latest(lang?: string): Promise<ApiEdition> {
    return this.getJson<ApiEdition>(`/api/news/latest${query({ lang })}`);
  }

  /** One day's edition (GET /api/news/editions/:day). */
  edition(day: string, lang?: string): Promise<ApiEdition> {
    return this.getJson<ApiEdition>(`/api/news/editions/${encodeURIComponent(day)}${query({ lang })}`);
  }

  /** The days with an edition, newest first (GET /api/news/days). */
  days(opts: { before?: string; limit?: number; lang?: string } = {}): Promise<ApiDaysResponse> {
    return this.getJson<ApiDaysResponse>(`/api/news/days${query({ before: opts.before, limit: opts.limit, lang: opts.lang })}`);
  }

  /** Stories matching `q` across every edition (GET /api/news/search). */
  search(opts: { q: string; region?: RegionId; limit?: number; lang?: string }): Promise<ApiSearchResponse> {
    return this.getJson<ApiSearchResponse>(`/api/news/search${query({ q: opts.q, region: opts.region, limit: opts.limit, lang: opts.lang })}`);
  }

  /** An edition's markdown: the newest (`latest`) or one day's, as the site serves /<day>.md. */
  async markdown(day: 'latest' | string): Promise<string> {
    const res = await this.get(`/${day === 'latest' ? 'latest' : encodeURIComponent(day)}.md`, 'text/markdown');
    return res.text();
  }

  /**
   * Ask for the daily email at `email` (POST /api/news/subscribe). The site mails the address a link to confirm and
   * sends nothing more until it is confirmed. Only the fields given are sent.
   */
  async subscribe(req: ApiSubscribeRequest): Promise<ApiSubscribeAnswer> {
    const body: ApiSubscribeRequest = { email: req.email };
    if (req.lang !== undefined && req.lang !== '') body.lang = req.lang;
    if (req.region !== undefined) body.region = req.region;
    if (req.timezone !== undefined && req.timezone !== '') body.timezone = req.timezone;
    const { status, body: answer } = await this.postJson<Partial<ApiSubscribeAnswer>>(SUBSCRIBE_PATH, body);
    if (answer === null || typeof answer !== 'object' || answer.state !== 'pending') {
      throw new NewsApiError(`News by Agents answered ${status} to the subscription without saying it is pending confirmation.`, status);
    }
    return { state: 'pending', message: typeof answer.message === 'string' && answer.message.trim() !== '' ? answer.message : 'Check the inbox for a link to confirm.' };
  }

  /** Where the token from a confirmation email is POSTed, as {"token": "..."}, to confirm without the page. */
  confirmUrl(): string {
    return `${this.origin}${SUBSCRIBE_CONFIRM_PATH}`;
  }

  /** The page of an edition on the site. */
  dayUrl(day: string): string {
    return `${this.origin}/${day}`;
  }
}

export function normalizeOrigin(origin: string): string {
  const url = new URL(origin);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`NEWSBYAGENTS_ORIGIN must be an http(s) URL, got ${origin}`);
  return url.origin;
}

function query(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s === '' ? '' : `?${s}`;
}

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Whether `s` is a real calendar day, YYYY-MM-DD. */
export function isDay(s: string): boolean {
  if (!DAY_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
