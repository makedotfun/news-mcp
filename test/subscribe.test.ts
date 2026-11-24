// news_subscribe and NewsClient.subscribe over the recorded POST /api/news/subscribe (test/helpers.ts subscribeAnswer):
// the request it sends, the answer it gives, and every way the site or the input can refuse it. No network.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { NewsApiError, NewsClient, USER_AGENT } from '../src/api.ts';
import { createNewsHandler, isTimezone } from '../src/server.ts';
import { SubscribeShape } from '../src/shapes.ts';
import { fixtureJson, newsAnswer, stubFetch, textOf, type Answer, type Asked } from './helpers.ts';

const ORIGIN = 'https://newsbyagents.com';
const PENDING = fixtureJson<{ state: string; message: string }>('subscribe-pending.json');

describe('NewsClient.subscribe', () => {
  test('POSTs the JSON body to /api/news/subscribe and returns the pending answer', async () => {
    const stub = stubFetch();
    const news = new NewsClient({ origin: ORIGIN, fetch: stub.fetch });
    const answer = await news.subscribe({ email: 'reader@example.com', lang: 'es', region: 'africa', timezone: 'Africa/Lagos' });
    assert.deepEqual(answer, PENDING);
    assert.equal(stub.requests.length, 1);
    const [req] = stub.requests;
    assert.equal(req?.url, `${ORIGIN}/api/news/subscribe`);
    assert.equal(req?.method, 'POST');
    assert.equal(req?.headers['content-type'], 'application/json');
    assert.equal(req?.headers.accept, 'application/json');
    assert.equal(req?.headers['user-agent'], USER_AGENT);
    assert.match(USER_AGENT, /^newsbyagents-mcp\/0\.2\.0 /);
    assert.deepEqual(JSON.parse(req?.body ?? ''), { email: 'reader@example.com', lang: 'es', region: 'africa', timezone: 'Africa/Lagos' });
    assert.equal(news.confirmUrl(), `${ORIGIN}/api/news/subscribe/confirm`);
  });

  test('sends only the fields it was given', async () => {
    const stub = stubFetch();
    await new NewsClient({ origin: ORIGIN, fetch: stub.fetch }).subscribe({ email: 'reader@example.com', lang: '', timezone: '' });
    assert.deepEqual(JSON.parse(stub.requests[0]?.body ?? ''), { email: 'reader@example.com' });
  });

  test("a 400 carries the site's message and status", async () => {
    const news = new NewsClient({ origin: ORIGIN, fetch: stubFetch().fetch });
    await assert.rejects(news.subscribe({ email: 'not-an-address' }), (err: unknown) => {
      assert.ok(err instanceof NewsApiError);
      assert.equal(err.status, 400);
      assert.equal(err.message, 'email must be an email address');
      return true;
    });
  });

  test('a 429 says when to retry', async () => {
    const news = new NewsClient({ origin: ORIGIN, fetch: stubFetch().fetch });
    await assert.rejects(news.subscribe({ email: 'slow@example.com' }), (err: unknown) => {
      assert.ok(err instanceof NewsApiError);
      assert.equal(err.status, 429);
      assert.equal(err.retryAfter, 60);
      assert.match(err.message, /limiting requests.*too many subscriptions from this address.*Try again in 60 seconds/);
      return true;
    });
  });

  test('a 5xx, a network failure and an answer that is not pending are errors', async () => {
    const answering = (a: Answer) => new NewsClient({ origin: ORIGIN, fetch: stubFetch(() => a).fetch });
    await assert.rejects(answering({ status: 503, body: 'upstream down' }).subscribe({ email: 'reader@example.com' }), /answered 503 \(upstream down\)\. Try again shortly/);
    await assert.rejects(answering({ status: 202, body: '<html>' }).subscribe({ email: 'reader@example.com' }), /something other than JSON for \/api\/news\/subscribe/);
    await assert.rejects(answering({ status: 200, body: '{"ok":true}' }).subscribe({ email: 'reader@example.com' }), /without saying it is pending/);
    const offline = new NewsClient({ origin: ORIGIN, fetch: async () => Promise.reject(new TypeError('fetch failed')) });
    await assert.rejects(offline.subscribe({ email: 'reader@example.com' }), (err: unknown) => err instanceof NewsApiError && err.status === 0 && /Could not reach https:\/\/newsbyagents\.com \(fetch failed\)/.test(err.message));
  });

  test('a pending answer without a message still reads as one', async () => {
    const news = new NewsClient({ origin: ORIGIN, fetch: stubFetch(() => ({ status: 202, body: '{"state":"pending"}' })).fetch });
    assert.deepEqual(await news.subscribe({ email: 'reader@example.com' }), { state: 'pending', message: 'Check the inbox for a link to confirm.' });
  });
});

describe('the news_subscribe tool', () => {
  let site: ReturnType<typeof stubFetch>;
  let answer: (url: URL, asked: Asked) => Answer | undefined = () => undefined;
  let handler: ReturnType<typeof createNewsHandler>;
  const client = new Client({ name: 'subscribe-test', version: '1.0.0' });

  before(async () => {
    site = stubFetch((url, asked) => answer(url, asked) ?? newsAnswer(url, asked));
    handler = createNewsHandler({ news: new NewsClient({ origin: ORIGIN, fetch: site.fetch }), worldSearch: false });
    await client.connect(new StreamableHTTPClientTransport(new URL('http://subscribe.test/mcp'), { fetch: (url, init) => handler.fetch(new Request(url, init)) }));
  });
  after(async () => {
    await client.close();
    await handler.close();
  });
  const posts = () => site.requests.filter((r) => r.method === 'POST');

  test('is advertised as a write that is safe to repeat, with its input and output schemas', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'news_subscribe');
    assert.ok(tool);
    assert.deepEqual(tool.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    assert.deepEqual(tool.inputSchema.required, ['email']);
    assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).sort(), ['email', 'lang', 'region', 'timezone']);
    assert.equal(tool.outputSchema?.type, 'object');
    assert.match(tool.description ?? '', /link to confirm/);
  });

  test('POSTs the subscription and says nothing is sent until it is confirmed', async () => {
    const before = posts().length;
    const r = await client.callTool({ name: 'news_subscribe', arguments: { email: 'reader@example.com', lang: 'fr', region: 'europe', timezone: 'Europe/Paris' } });
    assert.notEqual(r.isError, true, textOf(r));
    const out = SubscribeShape.parse(r.structuredContent);
    assert.deepEqual(out, { state: 'pending', message: PENDING.message, site: ORIGIN, confirmUrl: `${ORIGIN}/api/news/subscribe/confirm` });
    const sent = posts().slice(before);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.url, `${ORIGIN}/api/news/subscribe`);
    assert.deepEqual(JSON.parse(sent[0]?.body ?? ''), { email: 'reader@example.com', lang: 'fr', region: 'europe', timezone: 'Europe/Paris' });
    const md = textOf(r);
    assert.ok(md.startsWith(`Asked newsbyagents.com to send the daily front page to reader@example.com. ${PENDING.message}`));
    assert.match(md, /Nothing is sent until the address is confirmed/);
    assert.ok(md.includes(`POST {"token": "<token>"} to ${ORIGIN}/api/news/subscribe/confirm`));
  });

  test('only the email is required', async () => {
    const before = posts().length;
    const r = await client.callTool({ name: 'news_subscribe', arguments: { email: 'reader@example.com' } });
    assert.notEqual(r.isError, true, textOf(r));
    assert.deepEqual(JSON.parse(posts()[before]?.body ?? ''), { email: 'reader@example.com' });
  });

  test('malformed input is refused before anything is posted', async () => {
    const before = posts().length;
    for (const args of [
      {},
      { email: 'not-an-address' },
      { email: 'reader@example.com', region: 'mars' },
      { email: 'reader@example.com', lang: 'not a tag' },
      { email: 'reader@example.com', timezone: 'Mars/Olympus_Mons' },
      { email: 'reader@example.com', timezone: '../etc' },
    ]) {
      const r = await client.callTool({ name: 'news_subscribe', arguments: args });
      assert.equal(r.isError, true, JSON.stringify(args));
    }
    assert.equal(posts().length, before);
  });

  test("the site's 400 for an input it does not take reads as a refusal", async () => {
    const r = await client.callTool({ name: 'news_subscribe', arguments: { email: 'reader@example.com', lang: 'tlh' } });
    assert.equal(r.isError, true);
    assert.equal(textOf(r), 'The subscription was refused: lang must be a supported locale. Check the address, lang, region and timezone and try again.');
  });

  test('a 429 says when to retry', async () => {
    const r = await client.callTool({ name: 'news_subscribe', arguments: { email: 'slow@example.com' } });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /limiting requests.*Try again in 60 seconds/);
  });

  test('a site without the daily email says so', async () => {
    answer = (url, asked) => (asked.method === 'POST' ? { status: 404, body: JSON.stringify({ success: false, error: [{ message: 'not found' }] }), headers: { 'content-type': 'application/json' } } : undefined);
    try {
      const r = await client.callTool({ name: 'news_subscribe', arguments: { email: 'reader@example.com' } });
      assert.equal(r.isError, true);
      assert.equal(textOf(r), 'https://newsbyagents.com does not take email subscriptions (it answered 404).');
    } finally {
      answer = () => undefined;
    }
  });

  test('a 5xx is a tool error to retry', async () => {
    answer = (url, asked) => (asked.method === 'POST' ? { status: 502, body: 'bad gateway' } : undefined);
    try {
      const r = await client.callTool({ name: 'news_subscribe', arguments: { email: 'reader@example.com' } });
      assert.equal(r.isError, true);
      assert.match(textOf(r), /answered 502 \(bad gateway\)\. Try again shortly/);
    } finally {
      answer = () => undefined;
    }
  });
});

describe('isTimezone', () => {
  test('takes IANA zones and refuses the rest', () => {
    for (const ok of ['UTC', 'Europe/Berlin', 'America/New_York', 'America/Argentina/Buenos_Aires', 'Etc/GMT+5']) assert.ok(isTimezone(ok), ok);
    for (const bad of ['', 'Mars/Olympus_Mons', '../etc', 'Europe/', ' Europe/Berlin', 'Europe Berlin']) assert.ok(!isTimezone(bad), bad);
  });
});
