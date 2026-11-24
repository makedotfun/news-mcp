// The MCP server: four read-only tools over the front pages, search_world_news over GDELT (optional), news_subscribe
// for the daily email, the editions as markdown resources, and a briefing prompt. createNewsHandler serves it over
// streamable HTTP as a web-standard fetch handler, both protocol eras, JSON answers only.

import {
  createMcpHandler,
  isJsonContentType,
  isLegacyRequest,
  McpServer,
  ResourceNotFoundError,
  ResourceTemplate,
  WebStandardStreamableHTTPServerTransport,
  type CallToolResult,
  type McpHandlerRequestOptions,
  type McpHttpHandler,
} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { DAY_RE, isDay, NewsApiError, NewsClient, REGION_IDS, TranslationPendingError, type FetchLike } from './api.ts';
import { GdeltClient, GdeltError, GDELT_LABEL, GDELT_MAX_RECORDS, TIMESPAN_RE } from './gdelt.ts';
import { daysMarkdown, editionMarkdown, searchMarkdown, subscribeMarkdown, worldNewsMarkdown } from './markdown.ts';
import { DaysShape, daysOf, EditionShape, editionOf, SearchShape, searchOf, SubscribeShape, WorldNewsShape, worldNewsOf } from './shapes.ts';

export const SERVER_NAME = 'newsbyagents';
export const SERVER_VERSION = '0.2.0';

export { NewsClient, DEFAULT_ORIGIN } from './api.ts';
export { GdeltClient, Pacer } from './gdelt.ts';

/** Every tool the server can register, in the order tools/list answers them. */
export const NEWS_TOOL_NAMES = ['get_latest_news', 'get_news_for_date', 'list_news_dates', 'search_news', 'search_world_news', 'news_subscribe'] as const;
export type NewsToolName = (typeof NEWS_TOOL_NAMES)[number];

/** The tools a server built with these options registers: all of NEWS_TOOL_NAMES, less search_world_news when `worldSearch` is false. */
export function newsToolNames(opts: Pick<NewsServerOptions, 'worldSearch'> = {}): NewsToolName[] {
  return NEWS_TOOL_NAMES.filter((name) => name !== 'search_world_news' || opts.worldSearch !== false);
}

export interface NewsServerOptions {
  /** The News by Agents client; built from `origin` and `fetch` when absent. */
  news?: NewsClient;
  /** The GDELT client. Share one across servers in a process so its pacing holds for all of them. */
  gdelt?: GdeltClient;
  origin?: string;
  fetch?: FetchLike;
  /** Register search_world_news, the GDELT search (default true). False leaves it and its paragraph of the instructions out. */
  worldSearch?: boolean;
}

function instructionsOf(worldSearch: boolean): string {
  const paragraphs = [
    "News by Agents (newsbyagents.com) is a daily world news front page. Each day AI agents compete in a make.fun bounty to build it, and the winning entry becomes that day's edition: a few dozen stories across seven regions, each with a headline, a summary and links to the original reporting.",
    "Use get_latest_news for today's front page, get_news_for_date for a past day, list_news_dates to see which days exist, and search_news to find stories across every edition. An edition is provisional while the day's vote is open and final once the winner is picked.",
  ];
  if (worldSearch) {
    paragraphs.push(
      `search_world_news searches the open web's news through the GDELT Project. Its results are raw headlines, ${GDELT_LABEL}: say so when you use them, and prefer the curated tools for a summary of the day.`,
    );
  }
  paragraphs.push(
    "news_subscribe signs an email address up for the front page by email, each morning at 07:00 in the subscriber's timezone. Only use it for an address the user asked you to subscribe. The address gets a link to confirm, and nothing more is sent until it is confirmed.",
  );
  return paragraphs.join('\n\n');
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
/** news_subscribe changes state on the site, never destroys any, and asking twice is the same as asking once. */
const SUBSCRIBE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

/** Whether `tz` is an IANA timezone this runtime knows (Europe/Berlin, America/New_York, UTC). */
export function isTimezone(tz: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+)*$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const lang = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/, 'a BCP 47 language tag such as es, zh-Hans or he')
  .describe(
    'Language for the answer, a BCP 47 tag: es, fr, de, zh-Hans, ar, hi and two dozen more are ready at once; any other language is translated on first request, in which case the call says to retry in about 90 seconds. Leave out for English.',
  );
const region = z.enum(REGION_IDS).describe('Only stories from this region');
const day = z.string().regex(DAY_RE, 'a day as YYYY-MM-DD');

function text(t: string): CallToolResult['content'] {
  return [{ type: 'text', text: t }];
}

/** A tool error the model can act on: what went wrong and, where there is one, when to try again. */
function failure(err: unknown): CallToolResult {
  if (err instanceof TranslationPendingError) return { isError: true, content: text(`${err.message} (retry after ${err.retryAfter} s)`) };
  if (err instanceof NewsApiError) {
    if (err.status === 404) return { isError: true, content: text(`${err.message}. list_news_dates shows the days that have an edition.`) };
    return { isError: true, content: text(err.message) };
  }
  if (err instanceof GdeltError) return { isError: true, content: text(err.message) };
  return { isError: true, content: text(`Something went wrong: ${err instanceof Error ? err.message : String(err)}`) };
}

/** news_subscribe's errors: what the site said, in terms of the subscription. */
function subscribeFailure(err: unknown, origin: string): CallToolResult {
  if (err instanceof NewsApiError) {
    if (err.status === 400) return { isError: true, content: text(`The subscription was refused: ${err.message}. Check the address, lang, region and timezone and try again.`) };
    if (err.status === 404 || err.status === 405) return { isError: true, content: text(`${origin} does not take email subscriptions (it answered ${err.status}).`) };
  }
  return failure(err);
}

/** A fresh server instance. stdio builds one; the HTTP mode builds one per request around shared clients. */
export function createNewsServer(opts: NewsServerOptions = {}): McpServer {
  const news = opts.news ?? new NewsClient({ origin: opts.origin, fetch: opts.fetch });
  const worldSearch = opts.worldSearch !== false;
  const gdelt = worldSearch ? (opts.gdelt ?? new GdeltClient({ fetch: opts.fetch })) : undefined;

  const server = new McpServer(
    {
      name: SERVER_NAME,
      title: 'News by Agents',
      version: SERVER_VERSION,
      websiteUrl: 'https://newsbyagents.com',
    },
    { instructions: instructionsOf(worldSearch) },
  );

  server.registerTool(
    'get_latest_news',
    {
      title: "Today's front page",
      description:
        "The newest edition of News by Agents, the world news front page AI agents compete to build each day: its date, whether it is final or still provisional, and every story with its headline, summary, region, topic, the outlets it credits, links to the original articles and the story's page.",
      inputSchema: z.object({ lang: lang.optional(), region: region.optional() }),
      outputSchema: EditionShape,
      annotations: READ_ONLY,
    },
    async ({ lang: l, region: r }) => {
      try {
        const out = editionOf(await news.latest(l), r);
        return { content: text(editionMarkdown(out)), structuredContent: out };
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    'get_news_for_date',
    {
      title: 'Front page for a day',
      description: "One day's edition of News by Agents, the same shape as get_latest_news. 404s for a day with no edition: list_news_dates lists the days that have one.",
      inputSchema: z.object({ date: day.describe('The day, YYYY-MM-DD (UTC)'), lang: lang.optional(), region: region.optional() }),
      outputSchema: EditionShape,
      annotations: READ_ONLY,
    },
    async ({ date, lang: l, region: r }) => {
      if (!isDay(date)) return { isError: true, content: text(`${date} is not a real day: use YYYY-MM-DD.`) };
      try {
        const out = editionOf(await news.edition(date, l), r);
        return { content: text(editionMarkdown(out)), structuredContent: out };
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    'list_news_dates',
    {
      title: 'Days with an edition',
      description: 'The days that have a News by Agents edition, newest first, each with its title, status, story count and the agent whose front page won. Also names the make.fun bounty taking entries for the front page now.',
      inputSchema: z.object({
        before: day.optional().describe('Only days before this one, YYYY-MM-DD: page back through the archive with the oldest day of the last answer'),
        limit: z.number().int().min(1).max(366).optional().describe('How many days, 1 to 366 (default 30)'),
      }),
      outputSchema: DaysShape,
      annotations: READ_ONLY,
    },
    async ({ before, limit }) => {
      if (before !== undefined && !isDay(before)) return { isError: true, content: text(`${before} is not a real day: use YYYY-MM-DD.`) };
      try {
        const out = daysOf(await news.days({ before, limit }), (d) => news.dayUrl(d));
        return { content: text(daysMarkdown(out)), structuredContent: out };
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    'search_news',
    {
      title: 'Search the front pages',
      description: "Full-text search over every News by Agents edition's stories, best match first, each hit with its day, region, headline, summary, sources and a link to the story.",
      inputSchema: z.object({
        query: z.string().trim().min(2).max(200).describe('Words to find in headlines and summaries, 2 to 200 characters'),
        region: region.optional(),
        limit: z.number().int().min(1).max(50).optional().describe('How many hits, 1 to 50 (default 20)'),
        lang: lang.optional(),
      }),
      outputSchema: SearchShape,
      annotations: READ_ONLY,
    },
    async ({ query, region: r, limit, lang: l }) => {
      try {
        const out = searchOf(await news.search({ q: query, region: r, limit, lang: l }), r);
        return { content: text(searchMarkdown(out)), structuredContent: out };
      } catch (err) {
        return failure(err);
      }
    },
  );

  if (gdelt !== undefined) registerWorldSearch(server, gdelt);

  server.registerTool(
    'news_subscribe',
    {
      title: 'Daily news by email',
      description:
        "Sign an email address up for News by Agents by email: each morning at 07:00 in the subscriber's timezone, the newest front page with every story's summary and links. The address is sent a link to confirm, and nothing more is mailed until it is confirmed; every email has a one-click unsubscribe. Asking again for the same address is harmless. Only subscribe an address the user asked you to.",
      inputSchema: z.object({
        email: z.email().max(254).describe('The address to send the daily email to'),
        lang: lang
          .optional()
          .describe('The language of the email, a BCP 47 tag such as es, fr or zh-Hans. A day not yet translated comes in English. Leave out for English.'),
        region: region.optional().describe("Only this region's stories in the email; leave out for every story"),
        timezone: z
          .string()
          .trim()
          .max(64)
          .refine(isTimezone, 'an IANA timezone such as Europe/Berlin or America/New_York')
          .optional()
          .describe('The IANA timezone the 07:00 send is counted in, such as Europe/Berlin or America/New_York (default UTC)'),
      }),
      outputSchema: SubscribeShape,
      annotations: SUBSCRIBE,
    },
    async ({ email, lang: l, region: r, timezone }) => {
      try {
        const answer = await news.subscribe({ email, lang: l, region: r, timezone });
        const out: SubscribeShape = { state: answer.state, message: answer.message, site: news.origin, confirmUrl: news.confirmUrl() };
        return { content: text(subscribeMarkdown(out, email)), structuredContent: out };
      } catch (err) {
        return subscribeFailure(err, news.origin);
      }
    },
  );

  // ---------------------------------------------------------------- resources: the editions as markdown

  server.registerResource(
    'latest-edition',
    'news://latest',
    { title: "Today's front page", description: 'The newest News by Agents edition as markdown', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: await readMarkdown(news, 'latest', uri.href) }] }),
  );

  server.registerResource(
    'edition',
    new ResourceTemplate('news://{date}', {
      list: async () => {
        try {
          const { days } = await news.days({ limit: 30 });
          return { resources: days.map((d) => ({ uri: `news://${d.day}`, name: d.day, title: d.title, mimeType: 'text/markdown' })) };
        } catch {
          return { resources: [] };
        }
      },
    }),
    { title: 'Front page for a day', description: "One day's News by Agents edition as markdown: news://YYYY-MM-DD", mimeType: 'text/markdown' },
    async (uri, { date }) => {
      const d = Array.isArray(date) ? date[0] : date;
      if (d === undefined || !isDay(d)) throw new ResourceNotFoundError(uri.href, `${uri.href} names no day: use news://YYYY-MM-DD or news://latest`);
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: await readMarkdown(news, d, uri.href) }] };
    },
  );

  // ---------------------------------------------------------------- prompt

  server.registerPrompt(
    'daily_briefing',
    {
      title: 'Daily world news briefing',
      description: "A short briefing on today's world news from the News by Agents front page, optionally in another language.",
      argsSchema: z.object({ lang: z.string().optional().describe('A BCP 47 language tag for the briefing (es, fr, zh-Hans ...); English when left out') }),
    },
    ({ lang: l }) => {
      const tag = l?.trim() ?? '';
      const call = tag === '' ? 'get_latest_news' : `get_latest_news with lang "${tag}"`;
      const language = tag === '' ? '' : ` Write it in the language of the tag "${tag}".`;
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Call ${call} and brief me on today's world news from it. Open with the two or three stories that matter most and why, then a line or two per region (Europe, Middle East, Asia, Africa, Americas, Oceania, World). Name the outlets behind each story and link the original articles. Say whether the edition is final or still provisional, and keep it under 400 words.${language} If the tool says a translation is being prepared, wait the seconds it names and call it again.`,
            },
          },
        ],
      };
    },
  );

  return server;
}

function registerWorldSearch(server: McpServer, gdelt: GdeltClient): void {
  server.registerTool(
    'search_world_news',
    {
      title: 'Search world news (GDELT)',
      description: `Search recent news from around the world through the GDELT Project's free DOC 2.0 API: article titles, links, outlets, languages and countries, across 65 languages searched in English. Results are ${GDELT_LABEL}: raw headlines, nothing checked. GDELT takes one request every 5 seconds, so calls queue behind each other.`,
      inputSchema: z.object({
        query: z
          .string()
          .trim()
          .min(1)
          .max(500)
          .describe('Keywords; "quoted phrases", (a OR b) and -exclusions work as GDELT reads them. Each word must be at least 3 letters.'),
        timespan: z
          .string()
          .trim()
          .regex(TIMESPAN_RE, 'a number and a unit: 30min, 24h, 3d, 1w or 2m (months)')
          .optional()
          .describe('How far back: min, h, d, w or m (months), from 15min to 3m, e.g. 24h, 3d, 1w (default 24h)'),
        max_records: z.number().int().min(1).max(GDELT_MAX_RECORDS).optional().describe(`How many articles, 1 to ${GDELT_MAX_RECORDS} (default 25)`),
        source_country: z.string().trim().min(2).max(60).optional().describe('Only outlets in this country: a name (france, unitedkingdom) or a FIPS code (FR, UK)'),
        source_lang: z.string().trim().min(2).max(40).optional().describe('Only articles first published in this language: a name (spanish) or a 3-letter code (spa)'),
      }),
      outputSchema: WorldNewsShape,
      annotations: READ_ONLY,
    },
    async ({ query, timespan, max_records, source_country, source_lang }) => {
      try {
        const out = worldNewsOf(await gdelt.search({ query, timespan, maxRecords: max_records, sourceCountry: source_country, sourceLang: source_lang }));
        return { content: text(worldNewsMarkdown(out)), structuredContent: out };
      } catch (err) {
        return failure(err);
      }
    },
  );
}

async function readMarkdown(news: NewsClient, day: 'latest' | string, uri: string): Promise<string> {
  try {
    return await news.markdown(day);
  } catch (err) {
    if (err instanceof NewsApiError && err.status === 404) throw new ResourceNotFoundError(uri, `No News by Agents edition for ${day}`);
    throw err;
  }
}

export interface NewsHandlerOptions extends NewsServerOptions {
  /** Out-of-band errors and refused requests, for logging; never changes an answer. */
  onerror?: (error: Error) => void;
}

/**
 * The server over streamable HTTP as a web-standard handler: `fetch(request)` answers one POST to the MCP endpoint.
 * Stateless (a fresh server per request around one shared NewsClient and GdeltClient), both protocol eras, and JSON
 * answers only: a 2026-07-28 request is answered as one JSON body (mid-call notifications are dropped; the tools send
 * none), a 2025-era request by a stateless transport with JSON responses, and `subscriptions/listen` is refused, since
 * nothing here ever changes its lists. Any method but POST gets 405. The caller mounts it at its path and does its own
 * Host or Origin checks.
 */
export function createNewsHandler(opts: NewsHandlerOptions = {}): McpHttpHandler {
  const { onerror, ...serverOpts } = opts;
  const news = serverOpts.news ?? new NewsClient({ origin: serverOpts.origin, fetch: serverOpts.fetch });
  const gdelt = serverOpts.worldSearch === false ? undefined : (serverOpts.gdelt ?? new GdeltClient({ fetch: serverOpts.fetch }));
  const factory = () => createNewsServer({ ...serverOpts, news, gdelt });
  const report = (error: Error) => {
    try {
      onerror?.(error);
    } catch {
      // reporting only
    }
  };

  const modern = createMcpHandler(factory, { legacy: 'reject', responseMode: 'json', maxSubscriptions: 0, keepAliveMs: 0, onerror: report });

  /** One 2025-era request: initialize, tools/list, tools/call ... on a stateless transport answering JSON. */
  async function serveLegacy(request: Request, options?: McpHandlerRequestOptions): Promise<Response> {
    const server = factory();
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    transport.onerror = report;
    try {
      await server.connect(transport);
      return await transport.handleRequest(request, options);
    } finally {
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    }
  }

  const fetch = async (request: Request, options?: McpHandlerRequestOptions): Promise<Response> => {
    if (request.method.toUpperCase() !== 'POST') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed.' } }), {
        status: 405,
        headers: { 'content-type': 'application/json', allow: 'POST' },
      });
    }
    // A wrong Content-Type and a modern request both go to the modern handler: it answers 415 for the one, serves the other.
    if (isJsonContentType(request.headers.get('content-type')) && (await isLegacyRequest(request, options?.parsedBody))) return serveLegacy(request, options);
    return modern.fetch(request, options);
  };

  return { ...modern, fetch };
}
