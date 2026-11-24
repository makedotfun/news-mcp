// The built server as a client launches it: spawned over stdio (initialize, tools/list, tools/call get_latest_news),
// and in --http mode. Runs against dist/: `npm test` builds first.

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { FIXTURE_DAY, fixtureOrigin, textOf } from './helpers.ts';

const ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const FIXTURE_PORT = Number(process.env.TEST_FIXTURE_PORT ?? 45030);
const HTTP_PORT = Number(process.env.TEST_HTTP_PORT ?? 45031);
const skipLive = process.env.NEWSBYAGENTS_SKIP_LIVE === '1' ? 'NEWSBYAGENTS_SKIP_LIVE=1' : false;

/** The environment a client would hand the server, with only what it needs. */
function childEnv(origin?: string): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '' };
  // A proxied network (Node reads these when NODE_USE_ENV_PROXY=1) reaches the live tests the same way.
  for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'NODE_USE_ENV_PROXY']) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  if (origin !== undefined) env.NEWSBYAGENTS_ORIGIN = origin;
  return env;
}

async function roundTrip(env: Record<string, string>) {
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [ENTRY], env, stderr: 'pipe' });
  await client.connect(transport);
  try {
    const info = client.getServerVersion();
    const { tools } = await client.listTools();
    const latest = await client.callTool({ name: 'get_latest_news', arguments: {} });
    return { info, era: client.getProtocolEra(), tools, latest };
  } finally {
    await client.close();
  }
}

describe('stdio', () => {
  let origin: Awaited<ReturnType<typeof fixtureOrigin>>;
  before(async () => {
    origin = await fixtureOrigin(FIXTURE_PORT);
  });
  after(async () => {
    await origin.close();
  });

  test('initialize, tools/list and tools/call get_latest_news over the recorded API', async () => {
    const { info, era, tools, latest } = await roundTrip(childEnv(origin.origin));
    assert.equal(info?.name, 'newsbyagents');
    assert.equal(info?.version, '0.2.0');
    assert.equal(era, 'legacy');
    assert.equal(tools.length, 6);
    assert.notEqual(latest.isError, true, textOf(latest));
    const e = latest.structuredContent as { day: string; url: string; stories: unknown[] };
    assert.equal(e.day, FIXTURE_DAY);
    // URLs come from the API's answer, not from the origin the server dialled.
    assert.equal(e.url, `https://newsbyagents.com/${FIXTURE_DAY}`);
    assert.equal(e.stories.length, 35);
  });

  test('the same round trip against newsbyagents.com', { skip: skipLive }, async () => {
    const { tools, latest } = await roundTrip(childEnv());
    assert.equal(tools.length, 6);
    assert.notEqual(latest.isError, true, textOf(latest));
    const e = latest.structuredContent as { day: string; stories: unknown[] };
    assert.match(e.day, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(e.stories.length > 0);
  });
});

describe('--http', () => {
  let origin: Awaited<ReturnType<typeof fixtureOrigin>>;
  let child: ChildProcess;
  let url: URL;

  before(async () => {
    origin = await fixtureOrigin(FIXTURE_PORT + 2);
    child = spawn(process.execPath, [ENTRY, '--http', '--port', String(HTTP_PORT)], { env: childEnv(origin.origin), stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`--http did not start: ${stderr}`)), 10_000);
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
        const m = /on (http:\/\/\S+\/mcp)/.exec(stderr);
        if (m?.[1] !== undefined) {
          clearTimeout(timer);
          url = new URL(m[1]);
          resolve();
        }
      });
      child.once('exit', (code) => reject(new Error(`--http exited ${code}: ${stderr}`)));
    });
  });
  after(async () => {
    child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
    await origin.close();
  });

  for (const mode of ['legacy', 'auto'] as const) {
    test(`a ${mode === 'auto' ? '2026-07-28' : '2025'}-era client lists and calls the tools`, async () => {
      const client = new Client({ name: 'http-test', version: '1.0.0' }, mode === 'auto' ? { versionNegotiation: { mode: 'auto' } } : {});
      await client.connect(new StreamableHTTPClientTransport(url));
      try {
        assert.equal(client.getProtocolEra(), mode === 'auto' ? 'modern' : 'legacy');
        const { tools } = await client.listTools();
        assert.equal(tools.length, 6);
        const r = await client.callTool({ name: 'list_news_dates', arguments: { limit: 3 } });
        assert.notEqual(r.isError, true, textOf(r));
        assert.equal((r.structuredContent as { days: unknown[] }).days.length, 3);
      } finally {
        await client.close();
      }
    });
  }

  test('refuses a foreign Host header on the loopback bind', async () => {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(url, { method: 'POST', headers: { host: 'evil.example', 'content-type': 'application/json', accept: 'application/json, text/event-stream' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    });
    assert.equal(status, 403);
  });
});
