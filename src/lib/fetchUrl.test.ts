import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';

// agent.mjs ships no types; the dynamic import is untyped on purpose.
// @ts-ignore — no declaration file for the endpoint module
const { runFetchUrl } = await import('../../scripts/agent-endpoint/agent.mjs');

/**
 * fetch_url — the Website Currency Agent's way to read the live site.
 * SSRF guard: public http(s) only. The success path runs against a
 * local fixture server with FETCH_URL_ALLOW_LOCAL=1 (tests only — the
 * guard is live on the service); the refusal paths run with the guard on.
 */
describe('runFetchUrl', () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: '/page' });
        res.end();
        return;
      }
      if (req.url === '/loop') {
        res.writeHead(302, { Location: '/loop' });
        res.end();
        return;
      }
      if (req.url === '/plain') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('plain text body, no markup at all');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        '<html><head><title>Test page</title><style>.x{color:red}</style></head>' +
          '<body><h1>Hello world</h1><script>var x = 1;</script><p>The live site says hello.</p></body></html>',
      );
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as { port: number }).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('fetches a page and strips HTML to text', async () => {
    process.env.FETCH_URL_ALLOW_LOCAL = '1';
    try {
      const out = await runFetchUrl(JSON.stringify({ url: `http://127.0.0.1:${port}/page` }));
      expect(out).toContain('Hello world');
      expect(out).toContain('The live site says hello.');
      expect(out).not.toContain('<h1>');
      expect(out).not.toContain('var x = 1;');
      expect(out).not.toContain('.x{color:red}');
    } finally {
      delete process.env.FETCH_URL_ALLOW_LOCAL;
    }
  });

  it('returns plain text untouched', async () => {
    process.env.FETCH_URL_ALLOW_LOCAL = '1';
    try {
      const out = await runFetchUrl(JSON.stringify({ url: `http://127.0.0.1:${port}/plain` }));
      expect(out).toContain('plain text body, no markup at all');
    } finally {
      delete process.env.FETCH_URL_ALLOW_LOCAL;
    }
  });

  it('follows a redirect to a public path', async () => {
    process.env.FETCH_URL_ALLOW_LOCAL = '1';
    try {
      const out = await runFetchUrl(JSON.stringify({ url: `http://127.0.0.1:${port}/redirect` }));
      expect(out).toContain('Hello world');
    } finally {
      delete process.env.FETCH_URL_ALLOW_LOCAL;
    }
  });

  it('refuses a redirect loop', async () => {
    process.env.FETCH_URL_ALLOW_LOCAL = '1';
    try {
      await expect(runFetchUrl(JSON.stringify({ url: `http://127.0.0.1:${port}/loop` }))).rejects.toThrow(
        /redirect limit/,
      );
    } finally {
      delete process.env.FETCH_URL_ALLOW_LOCAL;
    }
  });

  it('refuses localhost and loopback addresses', async () => {
    await expect(runFetchUrl(JSON.stringify({ url: `http://127.0.0.1:${port}/page` }))).rejects.toThrow(
      /not a public address/,
    );
    await expect(runFetchUrl(JSON.stringify({ url: 'http://localhost:8897/chat' }))).rejects.toThrow(
      /localhost/,
    );
  });

  it('refuses private IP literals', async () => {
    await expect(runFetchUrl(JSON.stringify({ url: 'http://10.0.0.5/admin' }))).rejects.toThrow(
      /not a public address/,
    );
    await expect(runFetchUrl(JSON.stringify({ url: 'http://192.168.1.1/' }))).rejects.toThrow(
      /not a public address/,
    );
    await expect(runFetchUrl(JSON.stringify({ url: 'http://169.254.169.254/latest/meta-data/' }))).rejects.toThrow(
      /not a public address/,
    );
  });

  it('refuses non-http(s) schemes and bad input', async () => {
    await expect(runFetchUrl(JSON.stringify({ url: 'file:///etc/passwd' }))).rejects.toThrow(/only http\(s\)/);
    await expect(runFetchUrl(JSON.stringify({ url: 'not a url' }))).rejects.toThrow(/not a URL/);
    await expect(runFetchUrl('not json')).rejects.toThrow(/needs a JSON object/);
    await expect(runFetchUrl(JSON.stringify({}))).rejects.toThrow(/needs a JSON object/);
  });
});
