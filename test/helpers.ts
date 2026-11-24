// Shared test plumbing: the recorded fixtures, a fetch that answers from them, and a local origin that serves them.

import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

export const fixture = (name: string): string => readFileSync(`${FIXTURES}${name}`, 'utf8');
export const fixtureJson = <T = unknown>(name: string): T => JSON.parse(fixture(name)) as T;

/** The recorded edition is 2026-11-20; it stands in for "latest" as well. */
export const FIXTURE_DAY = '2026-11-20';

export interface Answer {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Answer => ({
  status,
  body: typeof body === 'string' ? body : JSON.stringify(body),
  headers: { 'content-type': 'application/json', ...headers },
});

/** A request as the fixtures see it: the method and, for a POST, its body. */
export interface Asked {
  method: string;
  body?: string;
}

const REGIONS = new Set(['europe', 'middle-east', 'asia', 'africa', 'americas', 'oceania', 'world']);
const SUBSCRIBE_LANGS = new Set(['en', 'es', 'fr', 'de', 'pt', 'zh-Hans', 'ar', 'hi', 'ja']);

/**
 * POST /api/news/subscribe as the site answers it: 400 (its usual error body) for a body that is not JSON or a
 * malformed email, lang, region or timezone; 429 for slow@example.com, standing in for the site's rate limit; else the
 * recorded 202, whatever the address's state.
 */
export function subscribeAnswer(body: string | undefined): Answer {
  let req: Record<string, unknown>;
  try {
    req = JSON.parse(body ?? '') as Record<string, unknown>;
  } catch {
    return json(400, { success: false, error: [{ message: 'body must be JSON', path: [] }] });
  }
  if (req === null || typeof req !== 'object') return json(400, { success: false, error: [{ message: 'body must be an object', path: [] }] });
  const bad = (path: string, message: string) => json(400, { success: false, error: [{ message, path: [path] }] });
  if (typeof req.email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(req.email)) return bad('email', 'email must be an email address');
  if (req.lang !== undefined && (typeof req.lang !== 'string' || !SUBSCRIBE_LANGS.has(req.lang))) return bad('lang', 'lang must be a supported locale');
  if (req.region !== undefined && (typeof req.region !== 'string' || !REGIONS.has(req.region))) return bad('region', 'region must be a news region');
  if (req.timezone !== undefined && (typeof req.timezone !== 'string' || !/^[A-Za-z_]+(\/[A-Za-z_]+)*$/.test(req.timezone))) return bad('timezone', 'timezone must be an IANA timezone');
  if (req.email === 'slow@example.com') return json(429, { success: false, error: [{ message: 'too many subscriptions from this address' }] }, { 'retry-after': '60' });
  return json(202, fixture('subscribe-pending.json'));
}

/**
 * The News by Agents API as recorded: latest and 2026-11-20 answer the edition, other days 404, an invalid day 400,
 * lang=yo the 202 of an on-demand translation, lang=tlh the 429 past the caps; days, search and the markdown twins;
 * POST /api/news/subscribe (subscribeAnswer). Any other POST is 405.
 */
export function newsAnswer(url: URL, asked: Asked = { method: 'GET' }): Answer {
  if (asked.method === 'POST') {
    if (url.pathname === '/api/news/subscribe') return subscribeAnswer(asked.body);
    return json(405, { success: false, error: [{ message: 'method not allowed' }] }, { allow: 'GET' });
  }
  const lang = url.searchParams.get('lang');
  if (lang === 'yo') return json(202, fixture('translation-queued.json'), { 'retry-after': '90' });
  if (lang === 'tlh') return json(429, { success: false, error: [{ message: 'too many new languages today' }] }, { 'retry-after': '30' });
  const p = url.pathname;
  if (p === '/api/news/latest' || p === `/api/news/editions/${FIXTURE_DAY}`) return json(200, fixture(`edition-${FIXTURE_DAY}.json`));
  const day = /^\/api\/news\/editions\/(.+)$/.exec(p);
  if (day !== null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day[1] ?? '')) return json(400, { success: false, error: [{ message: 'day must be a real UTC day, YYYY-MM-DD', path: ['day'] }] });
    return json(404, { success: false, error: [{ message: `no news edition for ${day[1]}` }] });
  }
  if (p === '/api/news/days') return json(200, fixture('days.json'));
  if (p === '/api/news/search') {
    const q = url.searchParams.get('q') ?? '';
    if (q === 'climate') return json(200, fixture('search-climate.json'));
    return json(200, { q, results: [] });
  }
  if (p === '/latest.md' || p === `/${FIXTURE_DAY}.md`) return { status: 200, body: fixture(`edition-${FIXTURE_DAY}.md`), headers: { 'content-type': 'text/markdown; charset=utf-8' } };
  if (/^\/\d{4}-\d{2}-\d{2}\.md$/.test(p)) return json(404, { success: false, error: [{ message: 'no news edition for that day' }] });
  return json(404, { success: false, error: [{ message: 'not found' }] });
}

/** A request the stub fetch was asked: its URL, method, headers and body. */
export interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** A fetch over newsAnswer, recording every URL it was asked (`calls`) and every request whole (`requests`). */
export function stubFetch(answer: (url: URL, asked: Asked) => Answer = newsAnswer): {
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  calls: string[];
  requests: Recorded[];
} {
  const calls: string[] = [];
  const requests: Recorded[] = [];
  return {
    calls,
    requests,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = typeof init?.body === 'string' ? init.body : undefined;
      calls.push(url.toString());
      requests.push({ url: url.toString(), method, headers: Object.fromEntries(new Headers(init?.headers).entries()), body });
      const a = answer(url, { method, body });
      return new Response(a.status === 204 ? null : a.body, { status: a.status, headers: a.headers });
    },
  };
}

/** A local origin serving the recorded API, for the spawned server's NEWSBYAGENTS_ORIGIN. */
export async function fixtureOrigin(port: number): Promise<{ origin: string; server: Server; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      const method = (req.method ?? 'GET').toUpperCase();
      const a = newsAnswer(new URL(req.url ?? '/', `http://127.0.0.1:${port}`), { method, body: method === 'POST' ? body : undefined });
      res.writeHead(a.status, a.headers ?? {});
      res.end(a.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${port}`, server, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** The first text block of a tool result. */
export function textOf(result: { content?: unknown }): string {
  const blocks = (result.content ?? []) as { type: string; text?: string }[];
  return blocks.find((b) => b.type === 'text')?.text ?? '';
}
