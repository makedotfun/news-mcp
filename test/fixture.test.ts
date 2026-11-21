// The server over the recorded fixtures, driven through a real MCP client in process (no network).

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { NewsClient, retryAfterSeconds } from '../src/api.ts';
import { GdeltClient, gdeltQuery, isValidTimespan, Pacer, seenDateIso } from '../src/gdelt.ts';
import { createNewsServer } from '../src/server.ts';
import { EditionShape } from '../src/shapes.ts';
import { FIXTURE_DAY, fixture, stubFetch, textOf, type Answer } from './helpers.ts';

const TOOLS = ['get_latest_news', 'get_news_for_date', 'list_news_dates', 'search_news', 'search_world_news'];

/** A pacer on a fake clock: sleeping only moves the clock, and every sleep is recorded. */
function fakePacer(intervalMs: number) {
  let now = 1_000_000;
  const sleeps: number[] = [];
  const pacer = new Pacer(intervalMs, {
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });
  return { pacer, sleeps, advance: (ms: number) => (now += ms) };
}

describe('over the recorded API', () => {
  const news = stubFetch();
  const gdeltCalls: string[] = [];
  let gdeltAnswers: Answer[] = [];
  const gdeltFetch = async (input: string | URL) => {
    gdeltCalls.push(String(input));
    const a = gdeltAnswers.shift() ?? { status: 200, body: fixture('gdelt-climate-france.json'), headers: { 'content-type': 'application/json' } };
    return new Response(a.body, { status: a.status, headers: a.headers });
  };
  const paced = fakePacer(5_000);
  const gdelt = new GdeltClient({ fetch: gdeltFetch, pacer: paced.pacer, backOffMs: 6_000 });
  const handler = createMcpHandler(() => createNewsServer({ news: new NewsClient({ origin: 'https://newsbyagents.com', fetch: news.fetch }), gdelt }));
  const client = new Client({ name: 'fixture-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });

  before(async () => {
    await client.connect(new StreamableHTTPClientTransport(new URL('http://fixture.test/mcp'), { fetch: (url, init) => handler.fetch(new Request(url, init)) }));
  });
  after(async () => {
    await client.close();
    await handler.close();
  });

  test('lists the five read-only tools, each with an output schema', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name),
      TOOLS,
    );
    for (const t of tools) {
      assert.equal(t.annotations?.readOnlyHint, true, t.name);
      assert.equal(t.annotations?.openWorldHint, true, t.name);
      assert.equal(t.outputSchema?.type, 'object', t.name);
    }
  });

  test('get_latest_news answers the edition as structuredContent and markdown', async () => {
    const r = await client.callTool({ name: 'get_latest_news', arguments: {} });
    assert.notEqual(r.isError, true, textOf(r));
    const e = EditionShape.parse(r.structuredContent);
    assert.equal(e.day, FIXTURE_DAY);
    assert.equal(e.status, 'provisional');
    assert.equal(e.storyCount, 35);
    assert.equal(e.stories.length, 35);
    assert.equal(e.url, `https://newsbyagents.com/${FIXTURE_DAY}`);
    assert.equal(e.voting?.closesAt, '2026-11-22T00:00:00.000Z');
    const first = e.stories[0];
    assert.ok(first);
    assert.equal(first.url, `https://newsbyagents.com/${FIXTURE_DAY}#story-${first.n}`);
    assert.ok(first.sources.length > 0 && first.sources.every((s) => /^https?:\/\//.test(s.url)));
    assert.ok(e.stories.some((s) => s.topic !== undefined));
    const md = textOf(r);
    assert.match(md, new RegExp(`^# ${e.title} \\(provisional\\)`));
    assert.ok(md.includes(first.headline));
    assert.ok(md.includes('Provisional: voting closes at 2026-11-22 00:00 UTC'));
  });

  test('a region keeps only its stories and still counts the whole edition', async () => {
    const r = await client.callTool({ name: 'get_latest_news', arguments: { region: 'asia' } });
    const e = EditionShape.parse(r.structuredContent);
    assert.ok(e.stories.length > 0 && e.stories.length < e.storyCount);
    assert.ok(e.stories.every((s) => s.region === 'asia'));
    assert.equal(e.region, 'asia');
    assert.match(textOf(r), /stories, Asia only:/);
  });

  test('get_news_for_date reads one day and turns a missing or impossible one into a tool error', async () => {
    const ok = await client.callTool({ name: 'get_news_for_date', arguments: { date: FIXTURE_DAY } });
    assert.equal(EditionShape.parse(ok.structuredContent).day, FIXTURE_DAY);

    const missing = await client.callTool({ name: 'get_news_for_date', arguments: { date: '2020-01-01' } });
    assert.equal(missing.isError, true);
    assert.match(textOf(missing), /no news edition for 2020-01-01.*list_news_dates/);

    const impossible = await client.callTool({ name: 'get_news_for_date', arguments: { date: '2026-02-30' } });
    assert.equal(impossible.isError, true);
    assert.match(textOf(impossible), /not a real day/);

    const malformed = await client.callTool({ name: 'get_news_for_date', arguments: { date: 'yesterday' } });
    assert.equal(malformed.isError, true);
  });

  test('a queued translation (202) says when to retry', async () => {
    const r = await client.callTool({ name: 'get_latest_news', arguments: { lang: 'yo' } });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /Yoruba \(yo\) edition of 2026-11-21 is being translated.*retry after 90 s/);
    assert.ok(news.calls.some((u) => u.endsWith('/api/news/latest?lang=yo')));
  });

  test('a 429 says when to retry', async () => {
    const r = await client.callTool({ name: 'get_news_for_date', arguments: { date: FIXTURE_DAY, lang: 'tlh' } });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /limiting requests.*too many new languages today.*Try again in 30 seconds/);
  });

  test('list_news_dates lists the days and the open bounty', async () => {
    const r = await client.callTool({ name: 'list_news_dates', arguments: { before: '2026-11-22', limit: 3 } });
    assert.notEqual(r.isError, true, textOf(r));
    const out = r.structuredContent as { days: { day: string; url: string }[]; openBounty: { url: string } | null };
    assert.equal(out.days.length, 3);
    assert.equal(out.days[0]?.url, `https://newsbyagents.com/${out.days[0]?.day}`);
    assert.ok(out.openBounty?.url.startsWith('https://make.fun/bounty/'));
    assert.ok(news.calls.some((u) => u.endsWith('/api/news/days?before=2026-11-22&limit=3')));
    assert.match(textOf(r), /^3 editions, newest first:/);
  });

  test('search_news finds stories across editions', async () => {
    const r = await client.callTool({ name: 'search_news', arguments: { query: 'climate', limit: 3 } });
    const out = r.structuredContent as { query: string; results: { url: string; headline: string }[] };
    assert.equal(out.query, 'climate');
    assert.ok(out.results.length > 0);
    assert.ok(out.results.every((x) => /^https:\/\/newsbyagents\.com\/\d{4}-\d{2}-\d{2}#story-\d+$/.test(x.url)));
    assert.match(textOf(r), /match "climate", best first/);

    const none = await client.callTool({ name: 'search_news', arguments: { query: 'nothing at all', region: 'oceania' } });
    assert.equal(textOf(none), 'No stories match "nothing at all" in Oceania.');

    const short = await client.callTool({ name: 'search_news', arguments: { query: 'a' } });
    assert.equal(short.isError, true);
  });

  test('search_world_news asks GDELT for an article list and labels it uncurated', async () => {
    const r = await client.callTool({ name: 'search_world_news', arguments: { query: 'climate', source_country: 'France', timespan: '24h', max_records: 3 } });
    assert.notEqual(r.isError, true, textOf(r));
    const out = r.structuredContent as { label: string; query: string; articles: { url: string; seenAt: string | null }[] };
    assert.equal(out.label, 'from GDELT, not curated');
    assert.equal(out.query, 'climate sourcecountry:france');
    assert.equal(out.articles.length, 3);
    assert.equal(out.articles[0]?.seenAt, '2026-11-21T06:45:00Z');
    const asked = new URL(gdeltCalls.at(-1) ?? '');
    assert.equal(asked.searchParams.get('mode'), 'artlist');
    assert.equal(asked.searchParams.get('format'), 'json');
    assert.equal(asked.searchParams.get('maxrecords'), '3');
    assert.equal(asked.searchParams.get('timespan'), '24h');
    assert.match(textOf(r), /^World news search results from GDELT, not curated: 3 articles/);
  });

  test('search_world_news retries a 429 after backing off, and gives up cleanly', async () => {
    paced.advance(60_000);
    paced.sleeps.length = 0;
    gdeltAnswers = [{ status: 429, body: 'Please limit requests to one every 5 seconds' }];
    const retried = await client.callTool({ name: 'search_world_news', arguments: { query: 'earthquake' } });
    assert.notEqual(retried.isError, true, textOf(retried));
    assert.deepEqual(paced.sleeps, [6_000]);

    gdeltAnswers = [429, 429, 429].map((status) => ({ status, body: 'Please limit requests' }));
    const refused = await client.callTool({ name: 'search_world_news', arguments: { query: 'earthquake' } });
    assert.equal(refused.isError, true);
    assert.match(textOf(refused), /GDELT is rate limiting/);
  });

  test('search_world_news passes on GDELT\'s own refusal and checks the timespan', async () => {
    gdeltAnswers = [{ status: 200, body: 'The specified phrase is too short.', headers: { 'content-type': 'text/html' } }];
    const refused = await client.callTool({ name: 'search_world_news', arguments: { query: 'ab' } });
    assert.equal(refused.isError, true);
    assert.match(textOf(refused), /GDELT refused the query: The specified phrase is too short/);

    const tooShort = await client.callTool({ name: 'search_world_news', arguments: { query: 'climate', timespan: '5min' } });
    assert.equal(tooShort.isError, true);
    assert.match(textOf(tooShort), /from 15min to 3m/);
  });

  test('resources: news://latest and news://{date} read the markdown twins', async () => {
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    assert.ok(uris.includes('news://latest'));
    assert.ok(uris.includes('news://2026-11-21'));
    const { resourceTemplates } = await client.listResourceTemplates();
    assert.deepEqual(
      resourceTemplates.map((t) => t.uriTemplate),
      ['news://{date}'],
    );

    const latest = await client.readResource({ uri: 'news://latest' });
    const day = await client.readResource({ uri: `news://${FIXTURE_DAY}` });
    for (const r of [latest, day]) {
      const c = r.contents[0] as { mimeType?: string; text?: string };
      assert.equal(c.mimeType, 'text/markdown');
      assert.match(c.text ?? '', /^# Friday 20 November 2026/);
    }
    assert.ok(news.calls.some((u) => u.endsWith('/latest.md')));
    await assert.rejects(client.readResource({ uri: 'news://2020-01-01' }), /No News by Agents edition for 2020-01-01/);
    await assert.rejects(client.readResource({ uri: 'news://tomorrow' }), /names no day/);
  });

  test('the daily_briefing prompt asks for get_latest_news in the asked language', async () => {
    const { prompts } = await client.listPrompts();
    assert.deepEqual(
      prompts.map((p) => p.name),
      ['daily_briefing'],
    );
    const plain = await client.getPrompt({ name: 'daily_briefing', arguments: {} });
    const es = await client.getPrompt({ name: 'daily_briefing', arguments: { lang: 'es' } });
    const textOfMessage = (m: (typeof plain.messages)[number] | undefined) => (m?.content as { text?: string } | undefined)?.text ?? '';
    assert.match(textOfMessage(plain.messages[0]), /^Call get_latest_news and brief me/);
    assert.match(textOfMessage(es.messages[0]), /get_latest_news with lang "es"/);
  });
});

describe('the pieces', () => {
  test('the pacer spaces calls at least the interval apart, one at a time', async () => {
    const { pacer, sleeps } = fakePacer(5_000);
    const order: string[] = [];
    await Promise.all(
      ['a', 'b', 'c'].map((x) =>
        pacer.run(async () => {
          order.push(x);
        }),
      ),
    );
    assert.deepEqual(order, ['a', 'b', 'c']);
    assert.deepEqual(sleeps, [5_000, 5_000]);
  });

  test('the pacer keeps going after a call that throws', async () => {
    const { pacer } = fakePacer(10);
    await assert.rejects(pacer.run(async () => Promise.reject(new Error('boom'))), /boom/);
    assert.equal(await pacer.run(async () => 'next'), 'next');
  });

  test('GDELT helpers', () => {
    assert.equal(gdeltQuery({ query: ' "climate change" ', sourceCountry: 'United Arab Emirates', sourceLang: 'Spanish' }), '"climate change" sourcecountry:unitedarabemirates sourcelang:spanish');
    assert.equal(seenDateIso('20261121T064500Z'), '2026-11-21T06:45:00Z');
    assert.equal(seenDateIso('soon'), null);
    for (const ok of ['15min', '24h', '3d', '1w', '3m', '2weeks']) assert.ok(isValidTimespan(ok), ok);
    for (const bad of ['10min', '4m', '1y', 'h', '']) assert.ok(!isValidTimespan(bad), bad);
  });

  test('Retry-After as seconds or a date', () => {
    assert.equal(retryAfterSeconds('90'), 90);
    assert.equal(retryAfterSeconds(null), null);
    assert.equal(retryAfterSeconds('Sun, 22 Nov 2026 00:00:00 GMT', Date.parse('2026-11-21T23:59:00Z')), 60);
  });
});
