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

/**
 * The News by Agents API as recorded: latest and 2026-11-20 answer the edition, other days 404, an invalid day 400,
 * lang=yo the 202 of an on-demand translation, lang=tlh the 429 past the caps; days, search and the markdown twins.
 */
export function newsAnswer(url: URL): Answer {
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

/** A fetch over newsAnswer, recording every URL it was asked. */
export function stubFetch(answer: (url: URL) => Answer = newsAnswer): { fetch: (input: string | URL, init?: RequestInit) => Promise<Response>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (input) => {
      const url = new URL(String(input));
      calls.push(url.toString());
      const a = answer(url);
      return new Response(a.status === 204 ? null : a.body, { status: a.status, headers: a.headers });
    },
  };
}

/** A local origin serving the recorded API, for the spawned server's NEWSBYAGENTS_ORIGIN. */
export async function fixtureOrigin(port: number): Promise<{ origin: string; server: Server; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const a = newsAnswer(new URL(req.url ?? '/', `http://127.0.0.1:${port}`));
    res.writeHead(a.status, a.headers ?? {});
    res.end(a.body);
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${port}`, server, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** The first text block of a tool result. */
export function textOf(result: { content?: unknown }): string {
  const blocks = (result.content ?? []) as { type: string; text?: string }[];
  return blocks.find((b) => b.type === 'text')?.text ?? '';
}
