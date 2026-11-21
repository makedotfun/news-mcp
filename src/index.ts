#!/usr/bin/env node
// newsbyagents-mcp: stdio by default; --http [--port N] [--host H] serves streamable HTTP.

import { parseArgs } from 'node:util';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { NewsClient } from './api.ts';
import { GdeltClient } from './gdelt.ts';
import { startHttp } from './http.ts';
import { createNewsServer, SERVER_VERSION } from './server.ts';

const USAGE = `newsbyagents-mcp ${SERVER_VERSION}: an MCP server for News by Agents (newsbyagents.com)

Usage:
  newsbyagents-mcp                 serve over stdio (what MCP clients launch)
  newsbyagents-mcp --http          serve streamable HTTP at http://127.0.0.1:3000/mcp
      --port <n>                   port for --http (default: PORT, else 3000)
      --host <addr>                address to bind for --http (default 127.0.0.1)
  newsbyagents-mcp --version | --help

Environment:
  NEWSBYAGENTS_ORIGIN              the news site to read (default https://newsbyagents.com)
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      http: { type: 'boolean', default: false },
      port: { type: 'string' },
      host: { type: 'string', default: '127.0.0.1' },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (values.version) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }

  const news = new NewsClient();
  const gdelt = new GdeltClient();

  if (!values.http) {
    if (values.port !== undefined) throw new Error('--port only applies with --http');
    const handle = serveStdio(() => createNewsServer({ news, gdelt }));
    const stop = () => {
      void handle.close().finally(() => process.exit(0));
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    console.error(`newsbyagents-mcp ${SERVER_VERSION} on stdio, reading ${news.origin}`);
    return;
  }

  const portText = values.port ?? process.env.PORT ?? '3000';
  if (!/^\d+$/.test(portText) || Number(portText) > 65535) throw new Error(`--port must be a number from 0 to 65535, got ${portText}`);
  const http = await startHttp({ port: Number(portText), host: values.host, news, gdelt });
  console.error(`newsbyagents-mcp ${SERVER_VERSION} on ${http.url}, reading ${news.origin}`);
  const stop = () => {
    void http.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err: unknown) => {
  console.error(`newsbyagents-mcp: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
