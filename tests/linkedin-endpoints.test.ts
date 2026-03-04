import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import app from '../src/index';

const TEST_WALLET = '0x1111111111111111111111111111111111111111';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// $0.03 in USDC (6 decimals) = 30000
const AMOUNT_0_03 = '0x0000000000000000000000000000000000000000000000000000000000007530';
// $0.05 in USDC = 50000
const AMOUNT_0_05 = '0x000000000000000000000000000000000000000000000000000000000000c350';
// $0.10 in USDC = 100000
const AMOUNT_0_10 = '0x00000000000000000000000000000000000000000000000000000000000186a0';

const LINKEDIN_PERSON_HTML = `<html>
<head><title>Jane Smith - Chief Technology Officer at TechCorp | LinkedIn</title></head>
<body>
<script type="application/ld+json">{"@type":"Person","name":"Jane Smith","description":"Chief Technology Officer at TechCorp","address":{"addressLocality":"San Francisco Bay Area"}}</script>
</body></html>`;

const LINKEDIN_COMPANY_HTML = `<html>
<head><title>OpenAI - Artificial Intelligence | LinkedIn</title></head>
<body>
<script type="application/ld+json">{"@type":"Organization","name":"OpenAI","description":"OpenAI is an AI research and deployment company.","industry":"Artificial Intelligence","address":{"addressLocality":"San Francisco, CA"}}</script>
</body></html>`;

const GOOGLE_SEARCH_HTML = `<html><body>
<a href="https://www.linkedin.com/in/janesmith-cto"><h3>Jane Smith - CTO at TechCorp - LinkedIn</h3></a>
<a href="https://www.linkedin.com/in/marcus-johnson-cto"><h3>Marcus Johnson - CTO - LinkedIn</h3></a>
</body></html>`;

let txCounter = 1;
let restoreFetch: (() => void) | null = null;

function nextBaseTxHash(): string {
  return `0x${(txCounter++).toString(16).padStart(64, '0')}`;
}

function toTopicAddress(address: string): string {
  return `0x${'0'.repeat(24)}${address.toLowerCase().replace(/^0x/, '')}`;
}

function installFetchMock(recipientAddress: string, amount: string): string[] {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

    calls.push(url);

    if (url.includes('mainnet.base.org')) {
      const payload = init?.body ? JSON.parse(String(init.body)) : {};
      if (payload?.method !== 'eth_getTransactionReceipt') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          status: '0x1',
          logs: [{
            address: USDC_BASE,
            topics: [
              TRANSFER_TOPIC,
              toTopicAddress('0x0000000000000000000000000000000000000000'),
              toTopicAddress(recipientAddress),
            ],
            data: amount,
          }],
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (url.includes('linkedin.com/in/')) {
      return new Response(LINKEDIN_PERSON_HTML, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }

    if (url.includes('linkedin.com/company/')) {
      return new Response(LINKEDIN_COMPANY_HTML, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }

    if (url.includes('google.com/search')) {
      return new Response(GOOGLE_SEARCH_HTML, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }

    if (url.includes('ipify.org')) {
      return new Response(JSON.stringify({ ip: '172.56.169.116' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`Unexpected fetch URL in test: ${url}`);
  }) as typeof fetch;

  restoreFetch = () => { globalThis.fetch = originalFetch; };
  return calls;
}

beforeEach(() => {
  process.env.WALLET_ADDRESS = TEST_WALLET;
});

afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
  process.env.WALLET_ADDRESS = TEST_WALLET;
});

// ─── LinkedIn Person ──────────────────────────────────────────────

describe('GET /api/linkedin/person', () => {
  test('returns 402 without payment', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/linkedin/person?url=linkedin.com/in/janesmith'),
    );
    expect(res.status).toBe(402);
    const body = await res.json() as any;
    expect(body.status).toBe(402);
    expect(body.price?.amount).toBe('0.03');
    expect(body.price?.currency).toBe('USDC');
  });

  test('returns 400 for missing url param', async () => {
    installFetchMock(TEST_WALLET, AMOUNT_0_03);
    const txHash = nextBaseTxHash();
    const res = await app.fetch(
      new Request('http://localhost/api/linkedin/person', {
        headers: { 'X-Payment-Signature': txHash, 'X-Payment-Network': 'base' },
      }),
    );
    expect(res.status).toBe(400);
  });

  test('returns 400 for invalid LinkedIn URL', async () => {
    installFetchMock(TEST_WALLET, AMOUNT_0_03);
    const txHash = nextBaseTxHash();
    const res = await app.fetch(
      new Request('http://localhost/api/linkedin/person?url=twitter.com/someuser', {
        headers: { 'X-Payment-Signature': txHash, 'X-Payment-Network': 'base' },
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain('Invalid LinkedIn');
  });

  test('payment accepted: returns 200 or 502 (scraper may fail without proxy in test env)', async () => {
    installFetchMock(TEST_WALLET, AMOUNT_0_03);
    const txHash = nextBaseTxHash();
    const res = await app.fetch(
      new Request('http://localhost/api/linkedin/person?url=linkedin.com/in/janesmith-cto', {
        headers: { 'X-Payment-Signature': txHash, 'X-Payment-Network': 'base' },
      }),
    );
    // 402 = payment rejected (fail). 200 = success. 502 = scraper failed (acceptable in test env without proxy).
    expect(res.status).not.toBe(402);
    expect([200, 502].includes(res.status)).toBe(true);
  });

  test('returns 500 without WALLET_ADDRESS env var', async () => {
    delete process.env.WALLET_ADDRESS;
    const res = await app.fetch(
      new Request('http://localhost/api/linkedin/person?url=linkedin.com/in/test'),
    );
    expect(res.status).toBe(500);
  });
});

// ─── LinkedIn Company ──────────────────────────────────────────────

describe('GET /api/linkedin/company', () => {
  test('returns 402 without payment', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/linkedin/company?url=linkedin.com/company/openai'),
    );
    expect(res.status).toBe(402);
    const body = await res.json() as any;
    expect(body.status).toBe(402);
    expect(body.price?.amount).toBe('0.05');
  });

  test('returns 400 for missing url', async () => {
    installFetchMock(TEST_WALLET, AMOUNT_0_05);
    const txHash = nextBaseTxHash();
    const res = await app.fetch(
      new Request('http://localhost/api/linkedin/company', {
        headers: { 'X-Payment-Signature': txHash, 'X-Payment-Network': 'base' },
      }),
    );
    expect(res.status).toBe(400);
  });

  test('returns 400 for invalid company URL', async () => {
    installFetchMock(TEST_WALLET, AMOUNT_0_05);
    const txHash = nextBaseTxHash();
    const res = await app.fetch(
      new Request('http://localhost/api/linkedin/company?url=google.com/openai', {
        headers: { 'X-Payment-Signature': txHash, 'X-Payment-Network': 'base' },
      }),
    );
    expect(res.status).toBe(400);
  });

  test('payment accepted: returns 200 or 502 (scraper may fail without proxy in test env)', async () => {
    installFetchMock(TEST_WALLET, AMOUNT_0_05);
    const txHash = nextBaseTxHash();
    const res = await app.fetch(
      new Request('http://localhost/api/linkedin/company?url=linkedin.com/company/openai', {
        headers: { 'X-Payment-Signature': txHash, 'X-Payment-Network': 'base' },
      }),
    );
    expect(res.status).not.toBe(402);
    expect([200, 502].includes(res.status)).toBe(true);
  });

  test('returns 500 without WALLET_ADDRESS', async () => {
    delete process.env.WALLET_ADDRESS;
    const res = await app.fetch(
      new Request('http://localhost/api/linkedin/company?url=linkedin.com/company/test'),
    );
    expect(res.status).toBe(500);
  });
});

// ─── LinkedIn Search People ──────────────────────────────────────────────

describe('GET /api/linkedin/search/people', () => {
  test('returns 402 without payment', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/linkedin/search/people?title=CTO&location=San+Francisco'),
    );
    expect(res.status).toBe(402);
    const body = await res.json() as any;
    expect(body.status).toBe(402);
    expect(body.price?.amount).toBe('0.1');
  });

  test('returns 400 for missing title', async () => {
    installFetchMock(TEST_WALLET, AMOUNT_0_10);
    const txHash = nextBaseTxHash();
    const res = await app.fetch(
      new Request('http://localhost/api/linkedin/search/people?location=NYC', {
        headers: { 'X-Payment-Signature': txHash, 'X-Payment-Network': 'base' },
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain('title');
  });

  test('payment accepted: returns 200 or 502 (scraper may fail without proxy in test env)', async () => {
    installFetchMock(TEST_WALLET, AMOUNT_0_10);
    const txHash = nextBaseTxHash();
    const res = await app.fetch(
      new Request('http://localhost/api/linkedin/search/people?title=CTO&location=San+Francisco', {
        headers: { 'X-Payment-Signature': txHash, 'X-Payment-Network': 'base' },
      }),
    );
    expect(res.status).not.toBe(402);
    expect([200, 502].includes(res.status)).toBe(true);
  });

  test('returns 500 without WALLET_ADDRESS', async () => {
    delete process.env.WALLET_ADDRESS;
    const res = await app.fetch(
      new Request('http://localhost/api/linkedin/search/people?title=CTO'),
    );
    expect(res.status).toBe(500);
  });
});

// ─── LinkedIn Company Employees ──────────────────────────────────────────────

describe('GET /api/linkedin/company/:id/employees', () => {
  test('returns 402 without payment', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/linkedin/company/stripe/employees?title=engineer'),
    );
    expect(res.status).toBe(402);
    const body = await res.json() as any;
    expect(body.status).toBe(402);
    expect(body.price?.amount).toBe('0.1');
  });

  test('payment accepted: returns 200 or 502 (scraper may fail without proxy in test env)', async () => {
    installFetchMock(TEST_WALLET, AMOUNT_0_10);
    const txHash = nextBaseTxHash();
    const res = await app.fetch(
      new Request('http://localhost/api/linkedin/company/stripe/employees?title=engineer', {
        headers: { 'X-Payment-Signature': txHash, 'X-Payment-Network': 'base' },
      }),
    );
    expect(res.status).not.toBe(402);
    expect([200, 502].includes(res.status)).toBe(true);
  });

  test('returns 500 without WALLET_ADDRESS', async () => {
    delete process.env.WALLET_ADDRESS;
    const res = await app.fetch(
      new Request('http://localhost/api/linkedin/company/stripe/employees'),
    );
    expect(res.status).toBe(500);
  });
});
