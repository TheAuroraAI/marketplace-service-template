/**
 * Service Router — Combined Marketplace Intelligence
 *
 * Endpoints:
 *   GET /api/jobs                    — Job market (Indeed/LinkedIn)
 *   GET /api/reviews/*               — Google Reviews
 *   GET /api/business/:place_id      — Business details
 *   GET /api/airbnb/*                — Airbnb market intelligence
 *   GET /api/amazon/*                — Amazon BSR tracking
 *   GET /api/predictions/*           — Prediction market signals
 *   GET /api/discover/*              — Google News/Discover feeds
 *   GET /api/appstore/*              — App Store intelligence
 */

import { Hono } from 'hono';
import { proxyFetch, getProxy } from './proxy';
import { extractPayment, verifyPayment, build402Response } from './payment';
import { scrapeIndeed, scrapeLinkedIn, type JobListing } from './scrapers/job-scraper';
import { fetchReviews, fetchBusinessDetails, fetchReviewSummary, searchBusinesses } from './scrapers/reviews';
import { searchAirbnb, getListingDetail, getListingReviews, getMarketStats } from './scrapers/airbnb-scraper';
import { scrapeProduct, searchAmazon, scrapeBestsellers, scrapeReviews as scrapeAmazonReviews } from './scrapers/amazon-scraper';
import { getTrendingMarkets, searchMarkets, getMarketDetails } from './scrapers/prediction-market-scraper';
import { getDiscoverFeed } from './scrapers/google-discover-scraper';
import { searchApps, getAppDetails, getTopCharts, getAppReviews } from './scrapers/app-store-scraper';

export const serviceRouter = new Hono();

const SERVICE_NAME = 'marketplace-intelligence';

async function getProxyExitIp(): Promise<string | null> {
  try {
    const r = await proxyFetch('https://api.ipify.org?format=json', {
      headers: { 'Accept': 'application/json' },
      maxRetries: 1,
      timeoutMs: 15_000,
    });
    if (!r.ok) return null;
    const data: any = await r.json();
    return typeof data?.ip === 'string' ? data.ip : null;
  } catch {
    return null;
  }
}

// ─── PROXY RATE LIMITING ────────────────────────────
const proxyUsage = new Map<string, { count: number; resetAt: number }>();
const PROXY_RATE_LIMIT = 20;

function checkProxyRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = proxyUsage.get(ip);
  if (!entry || now > entry.resetAt) {
    proxyUsage.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  entry.count++;
  return entry.count <= PROXY_RATE_LIMIT;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of proxyUsage) {
    if (now > entry.resetAt) proxyUsage.delete(ip);
  }
}, 300_000);

const SOLANA_WALLET = '6eUdVwsPArTxwVqEARYGCh4S2qwW2zCs7jSEDRpxydnv';

function getWallet(): string {
  return process.env.SOLANA_WALLET_ADDRESS || SOLANA_WALLET;
}

// ═══════════════════════════════════════════════════════
// ─── JOBS API ───────────────────────────────────────
// ═══════════════════════════════════════════════════════

serviceRouter.get('/jobs', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/jobs', 'Job Market Intelligence API (Indeed/LinkedIn)', 0.005, walletAddress, {
      input: { query: 'string (required)', location: 'string (default: Remote)', platform: '"indeed"|"linkedin"|"both"', limit: 'number (default: 20, max: 50)' },
      output: { results: 'JobListing[]', meta: '{ proxy, platform, limit }' },
    }), 402);
  }

  const verification = await verifyPayment(payment, walletAddress, 0.005);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);

  const query = c.req.query('query') || 'Software Engineer';
  const location = c.req.query('location') || 'Remote';
  const platform = (c.req.query('platform') || 'indeed').toLowerCase();
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '20') || 20, 1), 50);

  try {
    let results: JobListing[] = [];
    if (platform === 'both') {
      const [a, b] = await Promise.all([scrapeIndeed(query, location, limit), scrapeLinkedIn(query, location, limit)]);
      results = [...a, ...b];
    } else if (platform === 'linkedin') {
      results = await scrapeLinkedIn(query, location, limit);
    } else {
      results = await scrapeIndeed(query, location, limit);
    }

    c.header('X-Payment-Settled', 'true');
    return c.json({ results, meta: { platform, limit }, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) {
    return c.json({ error: 'Scrape failed', message: err?.message || String(err) }, 502);
  }
});

// ═══════════════════════════════════════════════════════
// ─── GOOGLE REVIEWS API ─────────────────────────────
// ═══════════════════════════════════════════════════════

serviceRouter.get('/reviews/search', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/reviews/search', 'Search businesses by query + location', 0.01, walletAddress, {
      input: { query: 'string (required)', location: 'string (required)', limit: 'number (default: 10)' },
      output: { businesses: 'BusinessInfo[]', totalFound: 'number' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, 0.01);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);

  const query = c.req.query('query');
  const location = c.req.query('location');
  if (!query || !location) return c.json({ error: 'Missing required parameters: query and location' }, 400);

  try {
    const result = await searchBusinesses(query, location, Math.min(parseInt(c.req.query('limit') || '10') || 10, 20));
    c.header('X-Payment-Settled', 'true');
    return c.json({ ...result, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) {
    return c.json({ error: 'Search failed', message: err?.message || String(err) }, 502);
  }
});

serviceRouter.get('/reviews/summary/:place_id', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/reviews/summary/:place_id', 'Review summary stats', 0.005, walletAddress, {
      input: { place_id: 'string (in path)' }, output: { summary: 'ReviewSummary' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, 0.005);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);

  try {
    const result = await fetchReviewSummary(c.req.param('place_id'));
    c.header('X-Payment-Settled', 'true');
    return c.json({ ...result, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) {
    return c.json({ error: 'Summary fetch failed', message: err?.message || String(err) }, 502);
  }
});

serviceRouter.get('/reviews/:place_id', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/reviews/:place_id', 'Fetch Google reviews by Place ID', 0.02, walletAddress, {
      input: { place_id: 'string (in path)', sort: '"newest"|"relevant"|"highest"|"lowest"', limit: 'number (max 50)' },
      output: { reviews: 'ReviewData[]' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, 0.02);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);

  const sort = c.req.query('sort') || 'newest';
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '20') || 20, 1), 50);
  try {
    const result = await fetchReviews(c.req.param('place_id'), sort, limit);
    c.header('X-Payment-Settled', 'true');
    return c.json({ ...result, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) {
    return c.json({ error: 'Reviews fetch failed', message: err?.message || String(err) }, 502);
  }
});

serviceRouter.get('/business/:place_id', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/business/:place_id', 'Business details + review summary', 0.01, walletAddress, {
      input: { place_id: 'string (in path)' }, output: { business: 'BusinessInfo', summary: 'ReviewSummary' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, 0.01);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);

  try {
    const result = await fetchBusinessDetails(c.req.param('place_id'));
    c.header('X-Payment-Settled', 'true');
    return c.json({ ...result, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) {
    return c.json({ error: 'Business fetch failed', message: err?.message || String(err) }, 502);
  }
});

// ═══════════════════════════════════════════════════════
// ─── AIRBNB MARKET INTELLIGENCE (Bounty #78) ────────
// ═══════════════════════════════════════════════════════

serviceRouter.get('/airbnb/search', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/airbnb/search', 'Search Airbnb listings by location, dates, guests, price range', 0.02, walletAddress, {
      input: { location: 'string (required)', checkin: 'YYYY-MM-DD', checkout: 'YYYY-MM-DD', guests: 'number', price_min: 'number', price_max: 'number', limit: 'number (max 50)' },
      output: { results: 'AirbnbListing[]' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, 0.02);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);

  const location = c.req.query('location');
  if (!location) return c.json({ error: 'Missing required parameter: location' }, 400);

  try {
    const results = await searchAirbnb(
      location, c.req.query('checkin'), c.req.query('checkout'),
      Math.max(1, parseInt(c.req.query('guests') || '2') || 2),
      c.req.query('price_min') ? parseInt(c.req.query('price_min')!) : undefined,
      c.req.query('price_max') ? parseInt(c.req.query('price_max')!) : undefined,
      Math.min(Math.max(parseInt(c.req.query('limit') || '20') || 20, 1), 50)
    );
    c.header('X-Payment-Settled', 'true');
    return c.json({ location, results, totalResults: results.length, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) {
    return c.json({ error: 'Airbnb search failed', message: err?.message || String(err) }, 502);
  }
});

serviceRouter.get('/airbnb/listing/:id', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/airbnb/listing/:id', 'Airbnb listing detail: price, rating, host, amenities', 0.01, walletAddress, {
      input: { id: 'string (in path)' }, output: { listing: 'AirbnbListingDetail' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, 0.01);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);

  const id = c.req.param('id');
  if (!id || !/^\d+$/.test(id)) return c.json({ error: 'Invalid listing ID. Must be numeric.' }, 400);

  try {
    const listing = await getListingDetail(id);
    c.header('X-Payment-Settled', 'true');
    return c.json({ ...listing, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) {
    return c.json({ error: 'Listing fetch failed', message: err?.message || String(err) }, 502);
  }
});

serviceRouter.get('/airbnb/reviews/:listing_id', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/airbnb/reviews/:listing_id', 'Airbnb listing reviews', 0.01, walletAddress, {
      input: { listing_id: 'string (in path)', limit: 'number (max 20)' }, output: { reviews: 'AirbnbReview[]' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, 0.01);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);

  const listingId = c.req.param('listing_id');
  if (!listingId || !/^\d+$/.test(listingId)) return c.json({ error: 'Invalid listing ID' }, 400);

  try {
    const reviews = await getListingReviews(listingId, Math.min(parseInt(c.req.query('limit') || '10') || 10, 20));
    c.header('X-Payment-Settled', 'true');
    return c.json({ listing_id: listingId, reviews, totalReturned: reviews.length, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) {
    return c.json({ error: 'Reviews fetch failed', message: err?.message || String(err) }, 502);
  }
});

serviceRouter.get('/airbnb/market-stats', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/airbnb/market-stats', 'Market stats: ADR, occupancy, price distribution, property types', 0.05, walletAddress, {
      input: { location: 'string (required)', checkin: 'YYYY-MM-DD', checkout: 'YYYY-MM-DD' },
      output: { stats: '{ avg_daily_rate, median_daily_rate, total_listings, price_distribution, property_types }' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, 0.05);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);

  const location = c.req.query('location');
  if (!location) return c.json({ error: 'Missing required parameter: location' }, 400);

  try {
    const stats = await getMarketStats(location, c.req.query('checkin'), c.req.query('checkout'));
    c.header('X-Payment-Settled', 'true');
    return c.json({ ...stats, timestamp: new Date().toISOString(), payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) {
    return c.json({ error: 'Market stats failed', message: err?.message || String(err) }, 502);
  }
});

// ═══════════════════════════════════════════════════════
// ─── AMAZON BSR TRACKING (Bounty #72) ───────────────
// ═══════════════════════════════════════════════════════

serviceRouter.get('/amazon/product/:asin', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/amazon/product/:asin', 'Amazon product details: BSR, price, ratings, buy box', 0.02, walletAddress, {
      input: { asin: 'string (in path)', marketplace: 'string (default: us)' },
      output: { product: 'AmazonProduct' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, 0.02);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);

  const asin = c.req.param('asin');
  if (!asin || !/^[A-Z0-9]{10}$/.test(asin)) return c.json({ error: 'Invalid ASIN. Must be 10 alphanumeric characters.' }, 400);

  try {
    const marketplace = c.req.query('marketplace') || 'us';
    const product = await scrapeProduct(asin, marketplace);
    c.header('X-Payment-Settled', 'true');
    return c.json({ ...product, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) {
    return c.json({ error: 'Product scrape failed', message: err?.message || String(err) }, 502);
  }
});

serviceRouter.get('/amazon/search', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/amazon/search', 'Search Amazon products with BSR data', 0.02, walletAddress, {
      input: { query: 'string (required)', marketplace: 'string (default: us)', limit: 'number (max 50)' },
      output: { results: 'AmazonSearchResult[]' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, 0.02);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);

  const query = c.req.query('query');
  if (!query) return c.json({ error: 'Missing required parameter: query' }, 400);

  try {
    const results = await searchAmazon(query, c.req.query('marketplace') || 'us', c.req.query('category'), Math.min(parseInt(c.req.query('limit') || '20') || 20, 50));
    c.header('X-Payment-Settled', 'true');
    return c.json({ query, results, totalResults: results.length, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) {
    return c.json({ error: 'Amazon search failed', message: err?.message || String(err) }, 502);
  }
});

serviceRouter.get('/amazon/bestsellers', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/amazon/bestsellers', 'Amazon Best Sellers by category', 0.02, walletAddress, {
      input: { category: 'string (default: all)', marketplace: 'string (default: us)', limit: 'number (max 50)' },
      output: { items: 'BestsellerItem[]' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, 0.02);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);

  try {
    const items = await scrapeBestsellers(c.req.query('category') || 'all', c.req.query('marketplace') || 'us', Math.min(parseInt(c.req.query('limit') || '20') || 20, 50));
    c.header('X-Payment-Settled', 'true');
    return c.json({ category: c.req.query('category') || 'all', items, totalItems: items.length, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) {
    return c.json({ error: 'Bestsellers scrape failed', message: err?.message || String(err) }, 502);
  }
});

serviceRouter.get('/amazon/reviews/:asin', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/amazon/reviews/:asin', 'Amazon product reviews', 0.01, walletAddress, {
      input: { asin: 'string (in path)', marketplace: 'string', sort: '"recent"|"helpful"', limit: 'number (max 50)' },
      output: { reviews: 'AmazonReview[]' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, 0.01);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);

  const asin = c.req.param('asin');
  if (!asin || !/^[A-Z0-9]{10}$/.test(asin)) return c.json({ error: 'Invalid ASIN' }, 400);

  try {
    const reviews = await scrapeAmazonReviews(asin, c.req.query('marketplace') || 'us', c.req.query('sort') || 'recent', Math.min(parseInt(c.req.query('limit') || '20') || 20, 50));
    c.header('X-Payment-Settled', 'true');
    return c.json({ asin, reviews, totalReviews: reviews.length, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) {
    return c.json({ error: 'Reviews scrape failed', message: err?.message || String(err) }, 502);
  }
});

// ═══════════════════════════════════════════════════════
// ─── PREDICTION MARKET SIGNALS (Bounty #55) ─────────
// ═══════════════════════════════════════════════════════

serviceRouter.get('/predictions/trending', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/predictions/trending', 'Trending prediction markets from Polymarket, Metaculus, PredictIt', 0.02, walletAddress, {
      input: { category: 'string (optional)', limit: 'number (default: 20)' },
      output: { markets: 'PredictionMarket[]' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, 0.02);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);

  try {
    const result = await getTrendingMarkets(c.req.query('category') || '', parseInt(c.req.query('limit') || '20') || 20, proxyFetch);
    c.header('X-Payment-Settled', 'true');
    return c.json({ ...result, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) {
    return c.json({ error: 'Trending markets fetch failed', message: err?.message || String(err) }, 502);
  }
});

serviceRouter.get('/predictions/search', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/predictions/search', 'Search prediction markets by query', 0.02, walletAddress, {
      input: { query: 'string (required)', limit: 'number (default: 20)' },
      output: { markets: 'PredictionMarket[]' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, 0.02);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);

  const query = c.req.query('query');
  if (!query) return c.json({ error: 'Missing required parameter: query' }, 400);

  try {
    const result = await searchMarkets(query, parseInt(c.req.query('limit') || '20') || 20, proxyFetch);
    c.header('X-Payment-Settled', 'true');
    return c.json({ ...result, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) {
    return c.json({ error: 'Market search failed', message: err?.message || String(err) }, 502);
  }
});

serviceRouter.get('/predictions/details', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/predictions/details', 'Detailed prediction market data with outcomes and odds', 0.01, walletAddress, {
      input: { url: 'string (required) — Polymarket/Metaculus/PredictIt URL' },
      output: { market: 'MarketDetailResult' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, 0.01);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);

  const url = c.req.query('url');
  if (!url) return c.json({ error: 'Missing required parameter: url' }, 400);

  try {
    const result = await getMarketDetails(url, proxyFetch);
    c.header('X-Payment-Settled', 'true');
    return c.json({ ...result, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) {
    return c.json({ error: 'Market details fetch failed', message: err?.message || String(err) }, 502);
  }
});

// ═══════════════════════════════════════════════════════
// ─── GOOGLE NEWS/DISCOVER FEEDS (Bounty #52) ────────
// ═══════════════════════════════════════════════════════

serviceRouter.get('/discover/feed', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/discover/feed', 'Google News/Discover feed by country and category', 0.02, walletAddress, {
      input: { country: 'string (default: US)', category: 'string (default: top) — technology|science|business|entertainment|sports|health|world|news|top' },
      output: { articles: 'DiscoverItem[]' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, 0.02);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);

  const country = c.req.query('country') || 'US';
  const category = c.req.query('category') || 'top';

  try {
    const result = await getDiscoverFeed(country, category, proxyFetch);
    c.header('X-Payment-Settled', 'true');
    return c.json({ ...result, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) {
    return c.json({ error: 'Discover feed fetch failed', message: err?.message || String(err) }, 502);
  }
});

// ═══════════════════════════════════════════════════════
// ─── APP STORE INTELLIGENCE (Bounty #54) ────────────
// ═══════════════════════════════════════════════════════

serviceRouter.get('/appstore/search', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/appstore/search', 'Search Apple App Store and Google Play', 0.02, walletAddress, {
      input: { query: 'string (required)', store: '"apple"|"google"|"both" (default: both)', country: 'string (default: us)', limit: 'number (max 50)' },
      output: { results: 'AppInfo[]' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, 0.02);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);

  const query = c.req.query('query');
  if (!query) return c.json({ error: 'Missing required parameter: query' }, 400);

  try {
    const result = await searchApps(query, c.req.query('store') || 'both', c.req.query('country') || 'us', Math.min(parseInt(c.req.query('limit') || '20') || 20, 50), proxyFetch);
    c.header('X-Payment-Settled', 'true');
    return c.json({ ...result, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) {
    return c.json({ error: 'App search failed', message: err?.message || String(err) }, 502);
  }
});

serviceRouter.get('/appstore/details', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/appstore/details', 'App details: ratings, version, screenshots, description', 0.02, walletAddress, {
      input: { appId: 'string (required)', store: '"apple"|"google"', country: 'string (default: us)' },
      output: { app: 'AppInfo' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, 0.02);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);

  const appId = c.req.query('appId');
  if (!appId) return c.json({ error: 'Missing required parameter: appId' }, 400);

  try {
    const result = await getAppDetails(appId, c.req.query('store') || 'apple', c.req.query('country') || 'us', proxyFetch);
    c.header('X-Payment-Settled', 'true');
    return c.json({ ...result, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) {
    return c.json({ error: 'App details fetch failed', message: err?.message || String(err) }, 502);
  }
});

serviceRouter.get('/appstore/charts', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/appstore/charts', 'Top charts / app rankings by category', 0.02, walletAddress, {
      input: { category: 'string (optional)', store: '"apple"|"google"|"both"', country: 'string (default: us)', limit: 'number (max 50)' },
      output: { charts: 'AppInfo[]' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, 0.02);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);

  try {
    const result = await getTopCharts(c.req.query('category') || '', c.req.query('store') || 'both', c.req.query('country') || 'us', Math.min(parseInt(c.req.query('limit') || '20') || 20, 50), proxyFetch);
    c.header('X-Payment-Settled', 'true');
    return c.json({ ...result, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) {
    return c.json({ error: 'Charts fetch failed', message: err?.message || String(err) }, 502);
  }
});

serviceRouter.get('/appstore/reviews', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/appstore/reviews', 'App reviews from Apple App Store or Google Play', 0.01, walletAddress, {
      input: { appId: 'string (required)', store: '"apple"|"google"', country: 'string (default: us)', limit: 'number (max 50)' },
      output: { reviews: 'AppReview[]' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, 0.01);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);

  const appId = c.req.query('appId');
  if (!appId) return c.json({ error: 'Missing required parameter: appId' }, 400);

  try {
    const result = await getAppReviews(appId, c.req.query('store') || 'apple', c.req.query('country') || 'us', Math.min(parseInt(c.req.query('limit') || '10') || 10, 50), proxyFetch);
    c.header('X-Payment-Settled', 'true');
    return c.json({ ...result, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) {
    return c.json({ error: 'App reviews fetch failed', message: err?.message || String(err) }, 502);
  }
});
