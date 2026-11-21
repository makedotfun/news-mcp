// Streamable HTTP mode: one stateless endpoint at /mcp, a fresh server per request around shared clients.

import { createServer, type Server } from 'node:http';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { NewsClient } from './api.ts';
import type { GdeltClient } from './gdelt.ts';
import { createNewsServer, SERVER_VERSION } from './server.ts';

export const MCP_PATH = '/mcp';

export interface HttpOptions {
  port: number;
  host: string;
  news: NewsClient;
  gdelt: GdeltClient;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

export async function startHttp(opts: HttpOptions): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const handler = createMcpHandler(() => createNewsServer({ news: opts.news, gdelt: opts.gdelt }), {
    onerror: (err) => console.error(`newsbyagents-mcp: ${err.message}`),
  });
  const mcp = toNodeHandler(handler);
  // On a loopback bind, refuse other Host and Origin headers (DNS rebinding). A public bind is the operator's to front.
  const guarded = LOOPBACK.has(opts.host);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === MCP_PATH) {
      if (guarded && (!validateHost(req, res) || !validateOrigin(req, res))) return;
      void mcp(req, res);
      return;
    }
    if (path === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`newsbyagents-mcp ${SERVER_VERSION}: MCP over streamable HTTP at ${MCP_PATH}\n`);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`Not found. The MCP endpoint is ${MCP_PATH}\n`);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : opts.port;
  const hostForUrl = opts.host.includes(':') ? `[${opts.host}]` : opts.host;
  return {
    server,
    url: `http://${hostForUrl}:${port}${MCP_PATH}`,
    close: async () => {
      await handler.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
