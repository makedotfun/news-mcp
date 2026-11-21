// The MCP server: five read-only tools, the editions as markdown resources, and a briefing prompt.

import { McpServer, ResourceNotFoundError, ResourceTemplate, type CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { DAY_RE, isDay, NewsApiError, NewsClient, REGION_IDS, TranslationPendingError, type FetchLike } from './api.ts';
import { GdeltClient, GdeltError, GDELT_LABEL, GDELT_MAX_RECORDS, TIMESPAN_RE } from './gdelt.ts';
import { daysMarkdown, editionMarkdown, searchMarkdown, worldNewsMarkdown } from './markdown.ts';
import { DaysShape, daysOf, EditionShape, editionOf, SearchShape, searchOf, WorldNewsShape, worldNewsOf } from './shapes.ts';

export const SERVER_NAME = 'newsbyagents';
export const SERVER_VERSION = '0.1.0';

export { NewsClient, DEFAULT_ORIGIN } from './api.ts';
export { GdeltClient, Pacer } from './gdelt.ts';

export interface NewsServerOptions {
  /** The News by Agents client; built from `origin` and `fetch` when absent. */
  news?: NewsClient;
  /** The GDELT client. Share one across servers in a process so its pacing holds for all of them. */
  gdelt?: GdeltClient;
  origin?: string;
  fetch?: FetchLike;
}

const INSTRUCTIONS = `News by Agents (newsbyagents.com) is a daily world news front page. Each day AI agents compete in a make.fun bounty to build it, and the winning entry becomes that day's edition: a few dozen stories across seven regions, each with a headline, a summary and links to the original reporting.

Use get_latest_news for today's front page, get_news_for_date for a past day, list_news_dates to see which days exist, and search_news to find stories across every edition. An edition is provisional while the day's vote is open and final once the winner is picked.

search_world_news searches the open web's news through the GDELT Project. Its results are raw headlines, ${GDELT_LABEL}: say so when you use them, and prefer the curated tools for a summary of the day.`;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

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

/** A fresh server instance. stdio builds one; the HTTP mode builds one per request around shared clients. */
export function createNewsServer(opts: NewsServerOptions = {}): McpServer {
  const news = opts.news ?? new NewsClient({ origin: opts.origin, fetch: opts.fetch });
  const gdelt = opts.gdelt ?? new GdeltClient({ fetch: opts.fetch });

  const server = new McpServer(
    {
      name: SERVER_NAME,
      title: 'News by Agents',
      version: SERVER_VERSION,
      websiteUrl: 'https://newsbyagents.com',
    },
    { instructions: INSTRUCTIONS },
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

async function readMarkdown(news: NewsClient, day: 'latest' | string, uri: string): Promise<string> {
  try {
    return await news.markdown(day);
  } catch (err) {
    if (err instanceof NewsApiError && err.status === 404) throw new ResourceNotFoundError(uri, `No News by Agents edition for ${day}`);
    throw err;
  }
}
