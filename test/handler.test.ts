// createNewsHandler as a remote serves it: the web-standard fetch face driven by the SDK v2 client in both protocol
// eras (a 2025 initialize, a 2026-07-28 request), over the recorded API. Every answer is JSON, never a stream.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { NewsClient } from '../src/api.ts';
import { createNewsHandler, NEWS_TOOL_NAMES, newsToolNames, SERVER_VERSION } from '../src/server.ts';
import { FIXTURE_DAY, stubFetch, textOf } from './helpers.ts';

const ORIGIN = 'https://newsbyagents.com';
/** The remote's tools: the stdio package's five less search_world_news, plus news_subscribe. */
const REMOTE_TOOLS = ['get_latest_news', 'get_news_for_date', 'list_news_dates', 'search_news', 'news_subscribe'];

interface Exchange {
  method: string;
  protocolVersion: string | null;
  status: number;
  contentType: string | null;
}

/** A handler over the recorded API, with every HTTP exchange the client makes against it recorded. */
function remote(opts: { worldSearch?: boolean } = { worldSearch: false }) {
  const site = stubFetch();
  const errors: Error[] = [];
  const handler = createNewsHandler({ news: new NewsClient({ origin: ORIGIN, fetch: site.fetch }), onerror: (e) => errors.push(e), ...opts });
  const exchanges: Exchange[] = [];
  const fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(url, init);
    const res = await handler.fetch(request);
    exchanges.push({ method: request.method, protocolVersion: request.headers.get('mcp-protocol-version'), status: res.status, contentType: res.headers.get('content-type') });
    return res;
  };
  return { handler, site, errors, exchanges, fetch };
}

async function connected(r: ReturnType<typeof remote>, era: 'legacy' | 'modern'): Promise<Client> {
  const client = new Client({ name: 'handler-test', version: '1.0.0' }, era === 'modern' ? { versionNegotiation: { mode: 'auto' } } : {});
  await client.connect(new StreamableHTTPClientTransport(new URL('https://newsbyagents.test/mcp'), { fetch: r.fetch }));
  return client;
}

/** Every answer was one JSON body (or an empty 202 for a notification): no SSE anywhere. */
function assertJsonOnly(exchanges: Exchange[]): void {
  assert.ok(exchanges.length > 0);
  for (const x of exchanges) {
    if (x.status === 202) continue;
    assert.match(x.contentType ?? '', /^application\/json/, JSON.stringify(x));
  }
}

test('the tool-name exports', () => {
  assert.deepEqual([...NEWS_TOOL_NAMES], ['get_latest_news', 'get_news_for_date', 'list_news_dates', 'search_news', 'search_world_news', 'news_subscribe']);
  assert.deepEqual(newsToolNames({ worldSearch: false }), REMOTE_TOOLS);
  assert.deepEqual(newsToolNames(), [...NEWS_TOOL_NAMES]);
  assert.equal(SERVER_VERSION, '0.2.0');
});

describe('a 2025-era client', () => {
  const r = remote();
  let client: Client;
  before(async () => {
    client = await connected(r, 'legacy');
  });
  after(async () => {
    await client.close();
    await r.handler.close();
  });

  test('initializes on the legacy handshake and lists the remote tools', async () => {
    assert.equal(client.getProtocolEra(), 'legacy');
    assert.equal(client.getServerVersion()?.name, 'newsbyagents');
    assert.equal(client.getServerVersion()?.version, '0.2.0');
    const instructions = client.getInstructions() ?? '';
    assert.match(instructions, /news_subscribe/);
    assert.doesNotMatch(instructions, /GDELT|search_world_news/);
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name),
      REMOTE_TOOLS,
    );
    assert.deepEqual(
      tools.map((t) => t.name),
      newsToolNames({ worldSearch: false }),
    );
  });

  test('calls a tool, and every answer was JSON', async () => {
    const latest = await client.callTool({ name: 'get_latest_news', arguments: {} });
    assert.notEqual(latest.isError, true, textOf(latest));
    assert.equal((latest.structuredContent as { day: string }).day, FIXTURE_DAY);
    await assert.rejects(client.callTool({ name: 'search_world_news', arguments: { query: 'climate' } }), /Tool search_world_news not found/);
    assertJsonOnly(r.exchanges);
    assert.ok(r.exchanges.some((x) => x.method === 'POST' && x.status === 200));
    assert.ok(r.exchanges.every((x) => x.protocolVersion !== '2026-07-28'));
  });
});

describe('a 2026-07-28 client', () => {
  const r = remote();
  let client: Client;
  before(async () => {
    client = await connected(r, 'modern');
  });
  after(async () => {
    await client.close();
    await r.handler.close();
  });

  test('is served on the modern revision and lists the same tools', async () => {
    assert.equal(client.getProtocolEra(), 'modern');
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name),
      REMOTE_TOOLS,
    );
    assert.ok(r.exchanges.some((x) => x.protocolVersion === '2026-07-28' && x.status === 200));
  });

  test('calls tools, and every answer was JSON', async () => {
    const days = await client.callTool({ name: 'list_news_dates', arguments: { limit: 3 } });
    assert.notEqual(days.isError, true, textOf(days));
    assert.equal((days.structuredContent as { days: unknown[] }).days.length, 3);
    const sub = await client.callTool({ name: 'news_subscribe', arguments: { email: 'reader@example.com', timezone: 'Asia/Tokyo' } });
    assert.notEqual(sub.isError, true, textOf(sub));
    assert.equal((sub.structuredContent as { state: string }).state, 'pending');
    assertJsonOnly(r.exchanges);
  });

  test('refuses a subscriptions/listen stream', async () => {
    await assert.rejects(client.listen({ toolsListChanged: true }), /Subscription limit reached/);
    assertJsonOnly(r.exchanges);
  });
});

describe('the HTTP edges', () => {
  const r = remote();
  after(async () => {
    await r.handler.close();
  });

  test('any method but POST is 405 with Allow: POST', async () => {
    for (const method of ['GET', 'DELETE', 'PUT']) {
      const res = await r.handler.fetch(new Request('https://newsbyagents.test/mcp', { method }));
      assert.equal(res.status, 405, method);
      assert.equal(res.headers.get('allow'), 'POST');
      const body = (await res.json()) as { error: { code: number; message: string } };
      assert.equal(body.error.code, -32000);
    }
  });

  test('a body that is not JSON-typed is 415', async () => {
    const res = await r.handler.fetch(new Request('https://newsbyagents.test/mcp', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }));
    assert.equal(res.status, 415);
  });

  test('a 2025 tools/list without a session answers JSON', async () => {
    const post = (body: unknown) =>
      r.handler.fetch(
        new Request('https://newsbyagents.test/mcp', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
          body: JSON.stringify(body),
        }),
      );
    const res = await post({ jsonrpc: '2.0', id: 7, method: 'tools/list' });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^application\/json/);
    const body = (await res.json()) as { id: number; result: { tools: { name: string }[] } };
    assert.equal(body.id, 7);
    assert.deepEqual(
      body.result.tools.map((t) => t.name),
      REMOTE_TOOLS,
    );
  });

  test('worldSearch defaults on: all six tools', async () => {
    const full = remote({});
    const client = await connected(full, 'modern');
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(
        tools.map((t) => t.name),
        [...NEWS_TOOL_NAMES],
      );
      assert.match(client.getInstructions() ?? '', /GDELT/);
    } finally {
      await client.close();
      await full.handler.close();
    }
  });
});
