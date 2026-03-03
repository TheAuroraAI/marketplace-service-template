/**
 * Marketplace Service — Server Entry Point
 * ─────────────────────────────────────────
 * Mounts: /api/*
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serviceRouter } from './service';

const app = new Hono();

// ─── MIDDLEWARE ──────────────────────────────────────

app.use('*', logger());

app.use('*', cors({
  origin: '*',
  allowHeaders: ['Content-Type', 'Payment-Signature', 'X-Payment-Signature', 'X-Payment-Network'],
  exposeHeaders: ['X-Payment-Settled', 'X-Payment-TxHash', 'Retry-After'],
}));

// Security headers
app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
});

// Rate limiting (in-memory, per IP, resets every minute)
const rateLimits = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = parseInt(process.env.RATE_LIMIT || '60'); // requests per minute

app.use('*', async (c, next) => {
  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const now = Date.now();
  const entry = rateLimits.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimits.set(ip, { count: 1, resetAt: now + 60_000 });
  } else {
    entry.count++;
    if (entry.count > RATE_LIMIT) {
      c.header('Retry-After', '60');
      return c.json({ error: 'Rate limit exceeded', retryAfter: 60 }, 429);
    }
  }

  await next();
});

// Clean up rate limit map every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimits) {
    if (now > entry.resetAt) rateLimits.delete(ip);
  }
}, 300_000);

// ─── ROUTES ─────────────────────────────────────────

const ALL_ENDPOINTS = [
  '/api/jobs',
  '/api/reviews/search', '/api/reviews/summary/:place_id', '/api/reviews/:place_id', '/api/business/:place_id',
  '/api/airbnb/search', '/api/airbnb/listing/:id', '/api/airbnb/reviews/:listing_id', '/api/airbnb/market-stats',
  '/api/amazon/product/:asin', '/api/amazon/search', '/api/amazon/bestsellers', '/api/amazon/reviews/:asin',
  '/api/predictions/trending', '/api/predictions/search', '/api/predictions/details',
  '/api/discover/feed',
  '/api/appstore/search', '/api/appstore/details', '/api/appstore/charts', '/api/appstore/reviews',
  '/api/tiktok/trending', '/api/tiktok/hashtag', '/api/tiktok/creator', '/api/tiktok/sound',
  '/api/food/search', '/api/food/menu', '/api/food/compare',
  '/api/instagram/profile/:username', '/api/instagram/posts/:username', '/api/instagram/analyze/:username', '/api/instagram/analyze/:username/images', '/api/instagram/audit/:username',
  '/api/x/search', '/api/x/trending', '/api/x/user/:handle', '/api/x/user/:handle/tweets', '/api/x/thread/:tweet_id',
  '/api/linkedin/person', '/api/linkedin/company', '/api/linkedin/search/people', '/api/linkedin/company/:id/employees',
  '/api/marketplace/search', '/api/marketplace/listing/:id', '/api/marketplace/categories', '/api/marketplace/new',
  '/api/zillow/property/:zpid', '/api/zillow/search', '/api/zillow/comps/:zpid', '/api/zillow/market',
  '/api/reddit/search', '/api/reddit/trending', '/api/reddit/subreddit/:name', '/api/reddit/thread/*',
];

app.get('/health', (c) => c.json({
  status: 'healthy',
  service: 'marketplace-intelligence',
  version: '2.0.0',
  timestamp: new Date().toISOString(),
  endpoints: ALL_ENDPOINTS,
}));

app.get('/', (c) => c.json({
  name: 'marketplace-intelligence',
  description: 'Marketplace Intelligence API — Multi-vertical web scraping with x402 payment',
  version: '2.0.0',
  services: {
    jobs: { endpoints: ['/api/jobs'], description: 'Job Market Intelligence (Indeed/LinkedIn)' },
    reviews: { endpoints: ['/api/reviews/search', '/api/reviews/:place_id', '/api/reviews/summary/:place_id', '/api/business/:place_id'], description: 'Google Reviews & Business Data' },
    airbnb: { endpoints: ['/api/airbnb/search', '/api/airbnb/listing/:id', '/api/airbnb/reviews/:listing_id', '/api/airbnb/market-stats'], description: 'Airbnb Market Intelligence (#78)' },
    amazon: { endpoints: ['/api/amazon/product/:asin', '/api/amazon/search', '/api/amazon/bestsellers', '/api/amazon/reviews/:asin'], description: 'Amazon BSR Tracking (#72)' },
    predictions: { endpoints: ['/api/predictions/trending', '/api/predictions/search', '/api/predictions/details'], description: 'Prediction Market Signals (#55)' },
    discover: { endpoints: ['/api/discover/feed'], description: 'Google News/Discover Feeds (#52)' },
    appstore: { endpoints: ['/api/appstore/search', '/api/appstore/details', '/api/appstore/charts', '/api/appstore/reviews'], description: 'App Store Intelligence (#54)' },
    tiktok: { endpoints: ['/api/tiktok/trending', '/api/tiktok/hashtag', '/api/tiktok/creator', '/api/tiktok/sound'], description: 'TikTok Trend Intelligence (#51)' },
    food: { endpoints: ['/api/food/search', '/api/food/menu', '/api/food/compare'], description: 'Food Delivery Price Intelligence (#76)' },
    instagram: { endpoints: ['/api/instagram/profile/:username', '/api/instagram/posts/:username', '/api/instagram/analyze/:username', '/api/instagram/analyze/:username/images', '/api/instagram/audit/:username'], description: 'Instagram Intelligence + AI Vision (#71)' },
    twitter: { endpoints: ['/api/x/search', '/api/x/trending', '/api/x/user/:handle', '/api/x/user/:handle/tweets', '/api/x/thread/:tweet_id'], description: 'X/Twitter Real-Time Search (#73)' },
    linkedin: { endpoints: ['/api/linkedin/person', '/api/linkedin/company', '/api/linkedin/search/people', '/api/linkedin/company/:id/employees'], description: 'LinkedIn People & Company Enrichment (#77)' },
    facebook: { endpoints: ['/api/marketplace/search', '/api/marketplace/listing/:id', '/api/marketplace/categories', '/api/marketplace/new'], description: 'Facebook Marketplace Monitor (#75)' },
    zillow: { endpoints: ['/api/zillow/property/:zpid', '/api/zillow/search', '/api/zillow/comps/:zpid', '/api/zillow/market'], description: 'Real Estate Intelligence — Zillow (#79)' },
    reddit: { endpoints: ['/api/reddit/search', '/api/reddit/trending', '/api/reddit/subreddit/:name', '/api/reddit/thread/*'], description: 'Reddit Intelligence (#68)' },
  },
  totalEndpoints: ALL_ENDPOINTS.length,
  pricing: {
    currency: 'USDC',
    range: '$0.005 — $0.05 per request',
    networks: [
      { network: 'base', chainId: 'eip155:8453', recipient: '0xC0140eEa19bD90a7cA75882d5218eFaF20426e42', asset: 'USDC' },
      { network: 'solana', chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', recipient: 'GpXHXs5KfzfXbNKcMLNbAMsJsgPsBE7y5GtwVoiuxYvH', asset: 'USDC' },
    ],
  },
  links: {
    marketplace: 'https://agents.proxies.sx/marketplace/',
    github: 'https://github.com/bolivian-peru/marketplace-service-template',
  },
}));

app.route('/api', serviceRouter);

app.notFound((c) => c.json({ error: 'Not found', endpoints: ALL_ENDPOINTS }, 404));

app.onError((err, c) => {
  console.error(`[ERROR] ${err.message}`);
  return c.json({ error: 'Internal server error' }, 500);
});

export default {
  port: parseInt(process.env.PORT || '3000'),
  hostname: '0.0.0.0',
  fetch: app.fetch,
};
