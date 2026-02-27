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
 *   GET /api/tiktok/*                — TikTok trend intelligence
 *   GET /api/food/*                  — Food delivery price intelligence
 *   GET /api/instagram/*             — Instagram intelligence + AI vision
 *   GET /api/x/*                     — X/Twitter real-time search
 *   GET /api/linkedin/*              — LinkedIn people & company enrichment
 *   GET /api/marketplace/*           — Facebook Marketplace monitor
 *   GET /api/run                     — Ad Verification (Bounty #53)
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
import { getTrending, getHashtagData, getCreatorProfile, getSoundData } from './scrapers/tiktok-scraper';
import { searchRestaurants, getMenuPrices, comparePrices } from './scrapers/food-delivery-scraper';
import { getProfile as igGetProfile, getPosts as igGetPosts, analyzeProfile as igAnalyzeProfile, analyzeImages as igAnalyzeImages, auditProfile as igAuditProfile } from './scrapers/instagram-scraper';
import { searchTweets, getTrending as xGetTrending, getUserProfile as xGetUserProfile, getUserTweets, getThread } from './scrapers/x-twitter-scraper';
import { getPersonProfile, getCompanyProfile, searchPeople, getCompanyEmployees } from './scrapers/linkedin-scraper';
import { searchMarketplace, getListingDetail as fbGetListingDetail, getCategories, getNewListings } from './scrapers/facebook-marketplace-scraper';
import { scrapeProperty, searchZillow, getComparableSales, getMarketStatsByZip } from './scrapers/zillow-scraper';
import { searchReddit, getSubreddit, getTrending as redditGetTrending, getComments } from './scrapers/reddit-scraper';
import { getSearchAds, getDisplayAds, getAdvertiserAds } from './scrapers/ad-verification-scraper';

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

// ═══════════════════════════════════════════════════════
// ─── TIKTOK INTELLIGENCE API ────────────────────────
// ═══════════════════════════════════════════════════════

serviceRouter.get('/tiktok/trending', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/tiktok/trending', 'TikTok Trending Videos — trending videos, hashtags, and sounds by country', 0.02, walletAddress, {
      input: { country: 'string (optional, default: "US") — 2-letter country code' },
      output: { country: 'string', videos: 'TikTokVideo[]', trending_hashtags: '[]', trending_sounds: '[]' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, 0.02);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);
  try {
    const ip = await getProxyExitIp();
    const country = c.req.query('country') || 'US';
    const result = await getTrending(country, proxyFetch);
    c.header('X-Payment-Settled', 'true');
    c.header('X-Payment-TxHash', payment.txHash);
    return c.json({ ...result, proxy: { ip, type: 'mobile' }, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) {
    return c.json({ error: 'TikTok trending fetch failed', message: err?.message || String(err) }, 502);
  }
});

serviceRouter.get('/tiktok/hashtag', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/tiktok/hashtag', 'TikTok Hashtag Intelligence — videos and stats for a specific hashtag', 0.01, walletAddress, {
      input: { tag: 'string (required) — hashtag without #', country: 'string (optional, default: "US")' },
      output: { tag: 'string', videos: 'TikTokVideo[]', total_views: 'number' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, 0.01);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);
  const tag = c.req.query('tag');
  if (!tag) return c.json({ error: 'Missing required parameter: tag' }, 400);
  try {
    const ip = await getProxyExitIp();
    const country = c.req.query('country') || 'US';
    const result = await getHashtagData(tag, country, proxyFetch);
    c.header('X-Payment-Settled', 'true');
    c.header('X-Payment-TxHash', payment.txHash);
    return c.json({ ...result, proxy: { ip, type: 'mobile' }, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) {
    return c.json({ error: 'TikTok hashtag fetch failed', message: err?.message || String(err) }, 502);
  }
});

serviceRouter.get('/tiktok/creator', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/tiktok/creator', 'TikTok Creator Profile — followers, following, likes, recent videos', 0.02, walletAddress, {
      input: { username: 'string (required) — TikTok username with or without @' },
      output: { username: 'string', nickname: 'string', followers: 'number', following: 'number', likes: 'number', recent_videos: '[]' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, 0.02);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);
  const username = c.req.query('username');
  if (!username) return c.json({ error: 'Missing required parameter: username' }, 400);
  try {
    const ip = await getProxyExitIp();
    const result = await getCreatorProfile(username, proxyFetch);
    c.header('X-Payment-Settled', 'true');
    c.header('X-Payment-TxHash', payment.txHash);
    return c.json({ ...result, proxy: { ip, type: 'mobile' }, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) {
    return c.json({ error: 'TikTok creator fetch failed', message: err?.message || String(err) }, 502);
  }
});

serviceRouter.get('/tiktok/sound', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/tiktok/sound', 'TikTok Sound Intelligence — sound data and associated videos', 0.01, walletAddress, {
      input: { id: 'string (required) — TikTok sound/music ID' },
      output: { sound_id: 'string', name: 'string', author: 'string', uses: 'number', videos: '[]' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, 0.01);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);
  const id = c.req.query('id');
  if (!id) return c.json({ error: 'Missing required parameter: id' }, 400);
  try {
    const ip = await getProxyExitIp();
    const result = await getSoundData(id, proxyFetch);
    c.header('X-Payment-Settled', 'true');
    c.header('X-Payment-TxHash', payment.txHash);
    return c.json({ ...result, proxy: { ip, type: 'mobile' }, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) {
    return c.json({ error: 'TikTok sound fetch failed', message: err?.message || String(err) }, 502);
  }
});

// ═══════════════════════════════════════════════════════
// ─── FOOD DELIVERY INTELLIGENCE API ─────────────────
// ═══════════════════════════════════════════════════════

serviceRouter.get('/food/search', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/food/search', 'Food Delivery Search — find restaurants on DoorDash, Uber Eats, and Grubhub', 0.02, walletAddress, {
      input: { query: 'string (optional) — restaurant name or cuisine', location: 'string (required) — city, zip, or address' },
      output: { restaurants: '{ name, platform, rating, deliveryFee, deliveryTime, priceRange, cuisine, url }[]', metadata: '{ totalResults, platforms }' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, 0.02);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);
  const location = c.req.query('location');
  if (!location) return c.json({ error: 'Missing required parameter: location', example: '/api/food/search?query=pizza&location=NYC' }, 400);
  try {
    const ip = await getProxyExitIp();
    const query = c.req.query('query') || '';
    const result = await searchRestaurants(query, location, proxyFetch);
    c.header('X-Payment-Settled', 'true');
    c.header('X-Payment-TxHash', payment.txHash);
    return c.json({ ...result, proxy: { ip, type: 'mobile' }, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) {
    return c.json({ error: 'Food delivery search failed', message: err?.message || String(err) }, 502);
  }
});

serviceRouter.get('/food/menu', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/food/menu', 'Food Delivery Menu — get menu items and prices from any DoorDash/Uber Eats/Grubhub URL', 0.02, walletAddress, {
      input: { url: 'string (required) — restaurant URL from DoorDash, Uber Eats, or Grubhub' },
      output: { menu: '{ items: { name, price, description, category }[] }' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, 0.02);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);
  const url = c.req.query('url');
  if (!url) return c.json({ error: 'Missing required parameter: url' }, 400);
  try {
    const ip = await getProxyExitIp();
    const result = await getMenuPrices(url, proxyFetch);
    c.header('X-Payment-Settled', 'true');
    c.header('X-Payment-TxHash', payment.txHash);
    return c.json({ ...result, proxy: { ip, type: 'mobile' }, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) {
    return c.json({ error: 'Menu fetch failed', message: err?.message || String(err) }, 502);
  }
});

serviceRouter.get('/food/compare', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/food/compare', 'Food Delivery Price Comparison — compare prices across DoorDash, Uber Eats, and Grubhub', 0.03, walletAddress, {
      input: { query: 'string (required) — restaurant name or cuisine', location: 'string (required) — city, zip, or address' },
      output: { restaurants: 'RestaurantComparison[]', cheapestPlatform: 'string', metadata: '{ scrapedAt, platforms }' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, 0.03);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);
  const query = c.req.query('query');
  const location = c.req.query('location');
  if (!query || !location) return c.json({ error: 'Missing required parameters: query and location', example: '/api/food/compare?query=pizza&location=NYC' }, 400);
  try {
    const ip = await getProxyExitIp();
    const result = await comparePrices(query, location, proxyFetch);
    c.header('X-Payment-Settled', 'true');
    c.header('X-Payment-TxHash', payment.txHash);
    return c.json({ ...result, proxy: { ip, type: 'mobile' }, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) {
    return c.json({ error: 'Food price comparison failed', message: err?.message || String(err) }, 502);
  }
});

// ═══════════════════════════════════════════════════════
// ─── INSTAGRAM INTELLIGENCE + AI VISION API ─────────
// ═══════════════════════════════════════════════════════

const IG_PROFILE_PRICE  = 0.01;
const IG_POSTS_PRICE    = 0.02;
const IG_ANALYZE_PRICE  = 0.15;
const IG_IMAGES_PRICE   = 0.08;
const IG_AUDIT_PRICE    = 0.05;

serviceRouter.get('/instagram/profile/:username', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/instagram/profile/:username', 'Get Instagram profile data: followers, bio, engagement rate, posting frequency', IG_PROFILE_PRICE, walletAddress, {
      input: { username: 'string (required) — Instagram username (in URL path)' },
      output: { profile: 'InstagramProfile — username, full_name, bio, followers, following, posts_count, is_verified, is_business, engagement_rate, avg_likes, avg_comments, posting_frequency' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, IG_PROFILE_PRICE);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);
  const clientIp = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!checkProxyRateLimit(clientIp)) { c.header('Retry-After', '60'); return c.json({ error: 'Proxy rate limit exceeded. Max 20 requests/min.', retryAfter: 60 }, 429); }
  const username = c.req.param('username');
  if (!username) return c.json({ error: 'Missing username in URL path' }, 400);
  try {
    const proxy = getProxy();
    const profile = await igGetProfile(username);
    c.header('X-Payment-Settled', 'true'); c.header('X-Payment-TxHash', payment.txHash);
    return c.json({ profile, meta: { proxy: { country: proxy.country, type: 'mobile' } }, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) { return c.json({ error: 'Instagram profile fetch failed', message: err?.message || String(err) }, 502); }
});

serviceRouter.get('/instagram/posts/:username', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/instagram/posts/:username', 'Get recent Instagram posts: captions, likes, comments, hashtags, timestamps', IG_POSTS_PRICE, walletAddress, {
      input: { username: 'string (required) — Instagram username (in URL path)', limit: 'number (optional, default: 12, max: 50)' },
      output: { posts: 'InstagramPost[] — id, shortcode, type, caption, likes, comments, timestamp, image_url, video_url, is_sponsored, hashtags' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, IG_POSTS_PRICE);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);
  const clientIp = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!checkProxyRateLimit(clientIp)) { c.header('Retry-After', '60'); return c.json({ error: 'Proxy rate limit exceeded.', retryAfter: 60 }, 429); }
  const username = c.req.param('username');
  if (!username) return c.json({ error: 'Missing username in URL path' }, 400);
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '12') || 12, 1), 50);
  try {
    const proxy = getProxy();
    const posts = await igGetPosts(username, limit);
    c.header('X-Payment-Settled', 'true'); c.header('X-Payment-TxHash', payment.txHash);
    return c.json({ posts, meta: { username, count: posts.length, proxy: { country: proxy.country, type: 'mobile' } }, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) { return c.json({ error: 'Instagram posts fetch failed', message: err?.message || String(err) }, 502); }
});

serviceRouter.get('/instagram/analyze/:username', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/instagram/analyze/:username', 'Full Instagram analysis: profile + posts + AI vision analysis (account type, content themes, sentiment, authenticity, brand recommendations)', IG_ANALYZE_PRICE, walletAddress, {
      input: { username: 'string (required) — Instagram username (in URL path)' },
      output: { profile: 'InstagramProfile', posts: 'InstagramPost[]', ai_analysis: '{ account_type, content_themes, sentiment, authenticity, images_analyzed, model_used, recommendations }' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, IG_ANALYZE_PRICE);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);
  const clientIp = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!checkProxyRateLimit(clientIp)) { c.header('Retry-After', '60'); return c.json({ error: 'Proxy rate limit exceeded.', retryAfter: 60 }, 429); }
  const username = c.req.param('username');
  if (!username) return c.json({ error: 'Missing username in URL path' }, 400);
  try {
    const proxy = getProxy();
    const result = await igAnalyzeProfile(username);
    c.header('X-Payment-Settled', 'true'); c.header('X-Payment-TxHash', payment.txHash);
    return c.json({ ...result, meta: { proxy: { country: proxy.country, type: 'mobile' } }, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) { return c.json({ error: 'Instagram analysis failed', message: err?.message || String(err) }, 502); }
});

serviceRouter.get('/instagram/analyze/:username/images', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/instagram/analyze/:username/images', 'AI vision analysis of Instagram images: content themes, style, aesthetic consistency, brand safety', IG_IMAGES_PRICE, walletAddress, {
      input: { username: 'string (required) — Instagram username (in URL path)' },
      output: { images_analyzed: 'number', analysis: '{ account_type, content_themes, sentiment, authenticity, recommendations, model_used }' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, IG_IMAGES_PRICE);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);
  const clientIp = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!checkProxyRateLimit(clientIp)) { c.header('Retry-After', '60'); return c.json({ error: 'Proxy rate limit exceeded.', retryAfter: 60 }, 429); }
  const username = c.req.param('username');
  if (!username) return c.json({ error: 'Missing username in URL path' }, 400);
  try {
    const proxy = getProxy();
    const result = await igAnalyzeImages(username);
    c.header('X-Payment-Settled', 'true'); c.header('X-Payment-TxHash', payment.txHash);
    return c.json({ ...result, meta: { username, proxy: { country: proxy.country, type: 'mobile' } }, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) { return c.json({ error: 'Instagram image analysis failed', message: err?.message || String(err) }, 502); }
});

serviceRouter.get('/instagram/audit/:username', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/instagram/audit/:username', 'Instagram authenticity audit: fake follower detection, engagement pattern analysis, bot signals', IG_AUDIT_PRICE, walletAddress, {
      input: { username: 'string (required) — Instagram username (in URL path)' },
      output: { profile: 'InstagramProfile', authenticity: '{ score, verdict, face_consistency, engagement_pattern, follower_quality, comment_analysis, fake_signals }' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, IG_AUDIT_PRICE);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);
  const clientIp = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!checkProxyRateLimit(clientIp)) { c.header('Retry-After', '60'); return c.json({ error: 'Proxy rate limit exceeded.', retryAfter: 60 }, 429); }
  const username = c.req.param('username');
  if (!username) return c.json({ error: 'Missing username in URL path' }, 400);
  try {
    const proxy = getProxy();
    const result = await igAuditProfile(username);
    c.header('X-Payment-Settled', 'true'); c.header('X-Payment-TxHash', payment.txHash);
    return c.json({ ...result, meta: { proxy: { country: proxy.country, type: 'mobile' } }, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) { return c.json({ error: 'Instagram audit failed', message: err?.message || String(err) }, 502); }
});

// ═══════════════════════════════════════════════════════
// ─── X/TWITTER REAL-TIME SEARCH API ─────────────────
// ═══════════════════════════════════════════════════════

serviceRouter.get('/x/search', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/x/search', 'Search X/Twitter tweets by keyword/hashtag. Returns tweet text, author, engagement metrics.', 0.01, walletAddress, {
      input: { query: 'string (required) — search keywords or #hashtag', sort: '"latest" | "top" (optional, default: "latest")', limit: 'number (optional, default: 20, max: 50)' },
      output: { query: 'string', results: 'TweetResult[] — { id, author: { handle, name, verified }, text, created_at, likes, retweets, replies, url, hashtags }' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, 0.01);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);
  const query = c.req.query('query');
  if (!query) return c.json({ error: 'Missing required parameter: query' }, 400);
  const sort = (c.req.query('sort') || 'latest') as 'latest' | 'top';
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '20') || 20, 1), 50);
  try {
    const proxy = getProxy(); const ip = await getProxyExitIp();
    const results = await searchTweets(query, sort, limit, proxyFetch);
    c.header('X-Payment-Settled', 'true'); c.header('X-Payment-TxHash', payment.txHash);
    return c.json({ query, results, meta: { total_results: results.length, proxy: { ip, country: proxy.country, host: proxy.host, type: 'mobile' } }, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) { return c.json({ error: 'Search failed', message: err?.message || String(err) }, 502); }
});

serviceRouter.get('/x/trending', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/x/trending', 'Get trending topics on X/Twitter by country.', 0.005, walletAddress, {
      input: { country: 'string (optional, default: "US") — ISO 2-letter country code' },
      output: { country: 'string', topics: 'TrendingTopic[] — { name, tweet_count, category, url }' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, 0.005);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);
  const country = c.req.query('country') || 'US';
  try {
    const proxy = getProxy(); const ip = await getProxyExitIp();
    const topics = await xGetTrending(country, proxyFetch);
    c.header('X-Payment-Settled', 'true'); c.header('X-Payment-TxHash', payment.txHash);
    return c.json({ country, topics, meta: { total_topics: topics.length, proxy: { ip, country: proxy.country, host: proxy.host, type: 'mobile' } }, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) { return c.json({ error: 'Trending fetch failed', message: err?.message || String(err) }, 502); }
});

serviceRouter.get('/x/user/:handle', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/x/user/:handle', 'Get X/Twitter user profile with followers, bio, verification status.', 0.01, walletAddress, {
      input: { handle: 'string (required, in URL path) — X/Twitter username without @' },
      output: { profile: 'XUserProfile — { handle, name, bio, location, followers, following, tweets_count, verified, joined, profile_image, banner_image }' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, 0.01);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);
  const handle = c.req.param('handle');
  if (!handle) return c.json({ error: 'Missing handle in URL path' }, 400);
  try {
    const proxy = getProxy(); const ip = await getProxyExitIp();
    const profile = await xGetUserProfile(handle, proxyFetch);
    c.header('X-Payment-Settled', 'true'); c.header('X-Payment-TxHash', payment.txHash);
    return c.json({ profile, meta: { proxy: { ip, country: proxy.country, host: proxy.host, type: 'mobile' } }, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) { return c.json({ error: 'Profile fetch failed', message: err?.message || String(err) }, 502); }
});

serviceRouter.get('/x/user/:handle/tweets', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/x/user/:handle/tweets', 'Get recent tweets from an X/Twitter user.', 0.01, walletAddress, {
      input: { handle: 'string (required, in URL path)', limit: 'number (optional, default: 20, max: 50)' },
      output: { handle: 'string', tweets: 'TweetResult[]' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, 0.01);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);
  const handle = c.req.param('handle');
  if (!handle) return c.json({ error: 'Missing handle in URL path' }, 400);
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '20') || 20, 1), 50);
  try {
    const proxy = getProxy(); const ip = await getProxyExitIp();
    const tweets = await getUserTweets(handle, limit, proxyFetch);
    c.header('X-Payment-Settled', 'true'); c.header('X-Payment-TxHash', payment.txHash);
    return c.json({ handle, tweets, meta: { total_tweets: tweets.length, proxy: { ip, country: proxy.country, host: proxy.host, type: 'mobile' } }, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) { return c.json({ error: 'Tweets fetch failed', message: err?.message || String(err) }, 502); }
});

serviceRouter.get('/x/thread/:tweet_id', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/x/thread/:tweet_id', 'Extract full conversation thread from a tweet ID.', 0.02, walletAddress, {
      input: { tweet_id: 'string (required, in URL path) — numeric tweet/post ID' },
      output: { tweet_id: 'string', thread: 'ThreadTweet[] — { id, author, text, created_at, likes, retweets, replies }' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, 0.02);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);
  const tweetId = c.req.param('tweet_id');
  if (!tweetId) return c.json({ error: 'Missing tweet_id in URL path' }, 400);
  try {
    const proxy = getProxy(); const ip = await getProxyExitIp();
    const thread = await getThread(tweetId, proxyFetch);
    c.header('X-Payment-Settled', 'true'); c.header('X-Payment-TxHash', payment.txHash);
    return c.json({ tweet_id: tweetId, thread, meta: { thread_length: thread.length, proxy: { ip, country: proxy.country, host: proxy.host, type: 'mobile' } }, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) { return c.json({ error: 'Thread extraction failed', message: err?.message || String(err) }, 502); }
});

// ═══════════════════════════════════════════════════════
// ─── LINKEDIN PEOPLE & COMPANY ENRICHMENT API ───────
// ═══════════════════════════════════════════════════════

serviceRouter.get('/linkedin/person', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/linkedin/person', 'Extract LinkedIn person profile: name, headline, company, experience, education, skills, connections.', 0.03, walletAddress, {
      input: { url: 'string (required) — LinkedIn profile URL (e.g., linkedin.com/in/username)' },
      output: { profile: '{ name, headline, location, current_company, previous_companies[], education[], skills[], connections, profile_url }' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, 0.03);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);
  const url = c.req.query('url');
  if (!url) return c.json({ error: 'Missing required parameter: url', example: '/api/linkedin/person?url=linkedin.com/in/username' }, 400);
  const profileUrl = url.startsWith('http') ? url : `https://${url}`;
  try {
    const proxy = getProxy(); const ip = await getProxyExitIp();
    const profile = await getPersonProfile(profileUrl, proxyFetch);
    c.header('X-Payment-Settled', 'true'); c.header('X-Payment-TxHash', payment.txHash);
    return c.json({ profile, meta: { proxy: { ip, country: proxy.country, carrier: proxy.host, type: 'mobile' } }, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) { return c.json({ error: 'Profile fetch failed', message: err?.message || String(err) }, 502); }
});

serviceRouter.get('/linkedin/company', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/linkedin/company', 'Extract LinkedIn company profile: description, employee count, industry, headquarters, website, specialties.', 0.05, walletAddress, {
      input: { url: 'string (required) — LinkedIn company URL (e.g., linkedin.com/company/name)' },
      output: { company: '{ name, description, industry, employee_count, headquarters, website, specialties[], founded }' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, 0.05);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);
  const url = c.req.query('url');
  if (!url) return c.json({ error: 'Missing required parameter: url', example: '/api/linkedin/company?url=linkedin.com/company/google' }, 400);
  const companyUrl = url.startsWith('http') ? url : `https://${url}`;
  try {
    const proxy = getProxy(); const ip = await getProxyExitIp();
    const company = await getCompanyProfile(companyUrl, proxyFetch);
    c.header('X-Payment-Settled', 'true'); c.header('X-Payment-TxHash', payment.txHash);
    return c.json({ company, meta: { proxy: { ip, country: proxy.country, carrier: proxy.host, type: 'mobile' } }, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) { return c.json({ error: 'Company fetch failed', message: err?.message || String(err) }, 502); }
});

serviceRouter.get('/linkedin/search/people', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/linkedin/search/people', 'Search LinkedIn people by title, location, and industry. Returns up to 20 results.', 0.10, walletAddress, {
      input: { title: 'string (optional) — job title (e.g., "CTO")', location: 'string (optional) — location (e.g., "San Francisco")', industry: 'string (optional) — industry (e.g., "SaaS")' },
      output: { results: '{ name, headline, location, profile_url }[]', total_results: 'number' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, 0.10);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);
  const title = c.req.query('title') || '';
  const location = c.req.query('location') || '';
  const industry = c.req.query('industry') || '';
  if (!title && !location && !industry) return c.json({ error: 'At least one search parameter required: title, location, or industry' }, 400);
  try {
    const proxy = getProxy(); const ip = await getProxyExitIp();
    const result = await searchPeople(title, location, industry, proxyFetch);
    c.header('X-Payment-Settled', 'true'); c.header('X-Payment-TxHash', payment.txHash);
    return c.json({ ...result, meta: { proxy: { ip, country: proxy.country, carrier: proxy.host, type: 'mobile' } }, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) { return c.json({ error: 'Search failed', message: err?.message || String(err) }, 502); }
});

serviceRouter.get('/linkedin/company/:id/employees', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/linkedin/company/:id/employees', 'List employees at a company with optional title filter.', 0.10, walletAddress, {
      input: { id: 'string (required, in URL path) — company name or identifier', title: 'string (optional) — filter by job title (e.g., "engineer")' },
      output: { results: '{ name, headline, location, profile_url }[]', total_results: 'number' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, 0.10);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);
  const companyId = c.req.param('id');
  if (!companyId) return c.json({ error: 'Missing company ID in URL path' }, 400);
  const title = c.req.query('title') || '';
  try {
    const proxy = getProxy(); const ip = await getProxyExitIp();
    const result = await getCompanyEmployees(companyId, title, proxyFetch);
    c.header('X-Payment-Settled', 'true'); c.header('X-Payment-TxHash', payment.txHash);
    return c.json({ ...result, meta: { proxy: { ip, country: proxy.country, carrier: proxy.host, type: 'mobile' } }, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) { return c.json({ error: 'Employee search failed', message: err?.message || String(err) }, 502); }
});

// ═══════════════════════════════════════════════════════
// ─── FACEBOOK MARKETPLACE MONITOR API ───────────────
// ═══════════════════════════════════════════════════════

const FB_SEARCH_PRICE = 0.01;
const FB_LISTING_PRICE = 0.005;
const FB_MONITOR_PRICE = 0.02;

serviceRouter.get('/marketplace/search', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/marketplace/search', 'Search Facebook Marketplace listings by keyword, location, and price range.', FB_SEARCH_PRICE, walletAddress, {
      input: { query: 'string (required)', location: 'string', min_price: 'number', max_price: 'number', limit: 'number (default: 20)' },
      output: { results: 'MarketplaceListing[]', totalFound: 'number' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, FB_SEARCH_PRICE);
  if (!verification.valid) return c.json({ error: 'Payment failed', reason: verification.error }, 402);
  const query = c.req.query('query');
  if (!query) return c.json({ error: 'Missing query' }, 400);
  const clientIp = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!checkProxyRateLimit(clientIp)) { c.header('Retry-After', '60'); return c.json({ error: 'Rate limited' }, 429); }
  try {
    const proxy = getProxy(); const ip = await getProxyExitIp();
    const result = await searchMarketplace(query, { location: c.req.query('location'), minPrice: c.req.query('min_price') ? parseInt(c.req.query('min_price')!) : undefined, maxPrice: c.req.query('max_price') ? parseInt(c.req.query('max_price')!) : undefined }, Math.min(parseInt(c.req.query('limit') || '20') || 20, 40));
    c.header('X-Payment-Settled', 'true'); c.header('X-Payment-TxHash', payment.txHash);
    return c.json({ ...result, meta: { proxy: { ip, country: proxy.country, host: proxy.host, type: 'mobile' } }, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) { return c.json({ error: 'Search failed', message: err?.message || String(err) }, 502); }
});

serviceRouter.get('/marketplace/listing/:id', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/marketplace/listing/:id', 'Get Facebook Marketplace listing details: price, seller, condition, description, images.', FB_LISTING_PRICE, walletAddress, {
      input: { id: 'string (required, in URL path) — numeric listing ID' },
      output: { listing: 'MarketplaceListing — { id, title, price, condition, seller, location, images, description }' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, FB_LISTING_PRICE);
  if (!verification.valid) return c.json({ error: 'Payment failed', reason: verification.error }, 402);
  const id = c.req.param('id');
  if (!id || !/^\d+$/.test(id)) return c.json({ error: 'Invalid listing ID — must be numeric' }, 400);
  const clientIp = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!checkProxyRateLimit(clientIp)) { c.header('Retry-After', '60'); return c.json({ error: 'Rate limited' }, 429); }
  try {
    const proxy = getProxy(); const ip = await getProxyExitIp();
    const listing = await fbGetListingDetail(id);
    c.header('X-Payment-Settled', 'true'); c.header('X-Payment-TxHash', payment.txHash);
    return c.json({ ...listing, meta: { proxy: { ip, country: proxy.country, host: proxy.host, type: 'mobile' } }, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) { return c.json({ error: 'Fetch failed', message: err?.message || String(err) }, 502); }
});

serviceRouter.get('/marketplace/categories', async (c) => {
  return c.json({ location: c.req.query('location') || 'all', categories: await getCategories() });
});

serviceRouter.get('/marketplace/new', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/marketplace/new', 'Monitor new Facebook Marketplace listings — get items posted in the last N hours matching your query.', FB_MONITOR_PRICE, walletAddress, {
      input: { query: 'string (required)', since: 'string (default: "1h") — hours to look back', location: 'string', limit: 'number (default: 20)' },
      output: { results: 'MarketplaceListing[]', totalFound: 'number' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, FB_MONITOR_PRICE);
  if (!verification.valid) return c.json({ error: 'Payment failed', reason: verification.error }, 402);
  const query = c.req.query('query');
  if (!query) return c.json({ error: 'Missing query' }, 400);
  const clientIp = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!checkProxyRateLimit(clientIp)) { c.header('Retry-After', '60'); return c.json({ error: 'Rate limited' }, 429); }
  try {
    const proxy = getProxy(); const ip = await getProxyExitIp();
    const result = await getNewListings(query, parseInt(c.req.query('since') || '1') || 1, c.req.query('location'), Math.min(parseInt(c.req.query('limit') || '20') || 20, 40));
    c.header('X-Payment-Settled', 'true'); c.header('X-Payment-TxHash', payment.txHash);
    return c.json({ ...result, meta: { proxy: { ip, country: proxy.country, host: proxy.host, type: 'mobile' } }, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) { return c.json({ error: 'Monitor failed', message: err?.message || String(err) }, 502); }
});

// ═══════════════════════════════════════════════════════
// ─── REAL ESTATE INTELLIGENCE API (Zillow) ──────────
// ═══════════════════════════════════════════════════════

const REALESTATE_PROPERTY_PRICE = 0.02;
const REALESTATE_SEARCH_PRICE = 0.01;
const REALESTATE_COMPS_PRICE = 0.03;
const REALESTATE_MARKET_PRICE = 0.05;

serviceRouter.get('/zillow/property/:zpid', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/zillow/property/:zpid', 'Full Zillow property: price, Zestimate, price history, details, neighborhood scores, photos', REALESTATE_PROPERTY_PRICE, walletAddress, {
      input: { zpid: 'string (required, in path) — Zillow Property ID' },
      output: { zpid: 'string', address: 'string', price: 'number', zestimate: 'number', price_history: 'PriceHistoryEvent[]', details: 'PropertyDetails', neighborhood: 'NeighborhoodData', photos: 'string[]' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, REALESTATE_PROPERTY_PRICE);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);
  const zpid = c.req.param('zpid');
  if (!zpid || !/^\d+$/.test(zpid)) return c.json({ error: 'Invalid zpid. Must be numeric.' }, 400);
  const clientIp = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!checkProxyRateLimit(clientIp)) { c.header('Retry-After', '60'); return c.json({ error: 'Rate limited', retryAfter: 60 }, 429); }
  try {
    const proxy = getProxy(); const ip = await getProxyExitIp();
    const property = await scrapeProperty(zpid);
    c.header('X-Payment-Settled', 'true'); c.header('X-Payment-TxHash', payment.txHash);
    return c.json({ ...property, meta: { proxy: { ip, country: proxy.country, host: proxy.host, type: 'mobile' } }, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) { return c.json({ error: 'Property lookup failed', message: err?.message || String(err) }, 502); }
});

serviceRouter.get('/zillow/search', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/zillow/search', 'Search Zillow by address, ZIP, or city with filters', REALESTATE_SEARCH_PRICE, walletAddress, {
      input: { query: 'string (required)', type: '"for_sale"|"for_rent"|"sold"', min_price: 'number', max_price: 'number', beds: 'number', baths: 'number', limit: 'number (default: 20, max: 40)' },
      output: { results: 'SearchResult[] — zpid, address, price, zestimate, beds, baths, sqft, type, status' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, REALESTATE_SEARCH_PRICE);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);
  const query = c.req.query('query');
  if (!query) return c.json({ error: 'Missing required parameter: query' }, 400);
  const clientIp = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!checkProxyRateLimit(clientIp)) { c.header('Retry-After', '60'); return c.json({ error: 'Rate limited', retryAfter: 60 }, 429); }
  const filterType = c.req.query('type') as 'for_sale' | 'for_rent' | 'sold' | undefined;
  const minPrice = c.req.query('min_price') ? parseInt(c.req.query('min_price')!) : undefined;
  const maxPrice = c.req.query('max_price') ? parseInt(c.req.query('max_price')!) : undefined;
  const beds = c.req.query('beds') ? parseInt(c.req.query('beds')!) : undefined;
  const baths = c.req.query('baths') ? parseInt(c.req.query('baths')!) : undefined;
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '20') || 20, 1), 40);
  try {
    const proxy = getProxy(); const ip = await getProxyExitIp();
    const results = await searchZillow(query, { type: filterType, minPrice, maxPrice, beds, baths }, limit);
    c.header('X-Payment-Settled', 'true'); c.header('X-Payment-TxHash', payment.txHash);
    return c.json({ query, filters: { type: filterType || null, minPrice: minPrice || null, maxPrice: maxPrice || null, beds: beds || null, baths: baths || null }, results, totalResults: results.length, meta: { proxy: { ip, country: proxy.country, host: proxy.host, type: 'mobile' } }, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) { return c.json({ error: 'Zillow search failed', message: err?.message || String(err) }, 502); }
});

serviceRouter.get('/zillow/comps/:zpid', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/zillow/comps/:zpid', 'Comparable sales with distance and similarity scores', REALESTATE_COMPS_PRICE, walletAddress, {
      input: { zpid: 'string (required, in path)', limit: 'number (default: 10, max: 20)' },
      output: { comps: 'CompSale[] — zpid, address, price, sold_date, beds, baths, sqft, distance, similarity' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, REALESTATE_COMPS_PRICE);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);
  const zpid = c.req.param('zpid');
  if (!zpid || !/^\d+$/.test(zpid)) return c.json({ error: 'Invalid zpid.' }, 400);
  const clientIp = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!checkProxyRateLimit(clientIp)) { c.header('Retry-After', '60'); return c.json({ error: 'Rate limited', retryAfter: 60 }, 429); }
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '10') || 10, 1), 20);
  try {
    const proxy = getProxy(); const ip = await getProxyExitIp();
    const comps = await getComparableSales(zpid, limit);
    c.header('X-Payment-Settled', 'true'); c.header('X-Payment-TxHash', payment.txHash);
    return c.json({ zpid, comps, totalComps: comps.length, meta: { proxy: { ip, country: proxy.country, host: proxy.host, type: 'mobile' } }, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) { return c.json({ error: 'Comps lookup failed', message: err?.message || String(err) }, 502); }
});

serviceRouter.get('/zillow/market', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/zillow/market', 'ZIP-level market stats: median value, rent, inventory, days on market', REALESTATE_MARKET_PRICE, walletAddress, {
      input: { zip: 'string (required) — 5-digit US ZIP code' },
      output: { zipcode: 'string', median_home_value: 'number', median_list_price: 'number', median_rent: 'number', avg_days_on_market: 'number', inventory_count: 'number', price_change_yoy: 'number' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, REALESTATE_MARKET_PRICE);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);
  const zip = c.req.query('zip');
  if (!zip || !/^\d{5}$/.test(zip)) return c.json({ error: 'Invalid zip. Must be 5-digit US ZIP.' }, 400);
  const clientIp = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!checkProxyRateLimit(clientIp)) { c.header('Retry-After', '60'); return c.json({ error: 'Rate limited', retryAfter: 60 }, 429); }
  try {
    const proxy = getProxy(); const ip = await getProxyExitIp();
    const stats = await getMarketStatsByZip(zip);
    c.header('X-Payment-Settled', 'true'); c.header('X-Payment-TxHash', payment.txHash);
    return c.json({ ...stats, meta: { proxy: { ip, country: proxy.country, host: proxy.host, type: 'mobile' } }, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) { return c.json({ error: 'Market stats failed', message: err?.message || String(err) }, 502); }
});

// ═══════════════════════════════════════════════════════
// ─── REDDIT INTELLIGENCE API ────────────────────────
// ═══════════════════════════════════════════════════════

const REDDIT_SEARCH_PRICE = 0.005;
const REDDIT_COMMENTS_PRICE = 0.01;
const AD_VERIFICATION_PRICE = 0.03;

serviceRouter.get('/reddit/search', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/reddit/search', 'Search Reddit posts by keyword via mobile proxy', REDDIT_SEARCH_PRICE, walletAddress, {
      input: { query: 'string (required)', sort: '"relevance"|"hot"|"new"|"top"|"comments" (default: "relevance")', time: '"hour"|"day"|"week"|"month"|"year"|"all" (default: "all")', limit: 'number (default: 25, max: 100)', after: 'string (optional) — pagination token' },
      output: { posts: 'RedditPost[] — title, selftext, author, subreddit, score, upvoteRatio, numComments, createdUtc, permalink, url', after: 'string | null' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, REDDIT_SEARCH_PRICE);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);
  const query = c.req.query('query');
  if (!query) return c.json({ error: 'Missing required parameter: query', example: '/api/reddit/search?query=AI+agents&sort=relevance&time=week' }, 400);
  const sort = c.req.query('sort') || 'relevance';
  const time = c.req.query('time') || 'all';
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '25') || 25, 1), 100);
  const after = c.req.query('after') || undefined;
  try {
    const proxy = getProxy(); const ip = await getProxyExitIp();
    const result = await searchReddit(query, sort, time, limit, after);
    c.header('X-Payment-Settled', 'true'); c.header('X-Payment-TxHash', payment.txHash);
    return c.json({ ...result, meta: { query, sort, time, limit, proxy: { ip, country: proxy.country, host: proxy.host, type: 'mobile' } }, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) { return c.json({ error: 'Reddit search failed', message: err?.message || String(err) }, 502); }
});

serviceRouter.get('/reddit/trending', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/reddit/trending', 'Get trending/popular posts across Reddit via mobile proxy', REDDIT_SEARCH_PRICE, walletAddress, {
      input: { limit: 'number (default: 25, max: 100)' },
      output: { posts: 'RedditPost[] — trending posts from r/popular', after: 'string | null' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, REDDIT_SEARCH_PRICE);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '25') || 25, 1), 100);
  try {
    const proxy = getProxy(); const ip = await getProxyExitIp();
    const result = await redditGetTrending(limit);
    c.header('X-Payment-Settled', 'true'); c.header('X-Payment-TxHash', payment.txHash);
    return c.json({ ...result, meta: { limit, proxy: { ip, country: proxy.country, host: proxy.host, type: 'mobile' } }, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) { return c.json({ error: 'Reddit trending fetch failed', message: err?.message || String(err) }, 502); }
});

serviceRouter.get('/reddit/subreddit/:name', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/reddit/subreddit/:name', 'Browse a subreddit via mobile proxy', REDDIT_SEARCH_PRICE, walletAddress, {
      input: { name: 'string (required, in path) — subreddit name', sort: '"hot"|"new"|"top"|"rising" (default: "hot")', time: '"hour"|"day"|"week"|"month"|"year"|"all"', limit: 'number (default: 25, max: 100)', after: 'string (optional)' },
      output: { posts: 'RedditPost[]', after: 'string | null' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, REDDIT_SEARCH_PRICE);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);
  const name = c.req.param('name');
  if (!name) return c.json({ error: 'Missing subreddit name in URL path' }, 400);
  const sort = c.req.query('sort') || 'hot';
  const time = c.req.query('time') || 'all';
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '25') || 25, 1), 100);
  const after = c.req.query('after') || undefined;
  try {
    const proxy = getProxy(); const ip = await getProxyExitIp();
    const result = await getSubreddit(name, sort, time, limit, after);
    c.header('X-Payment-Settled', 'true'); c.header('X-Payment-TxHash', payment.txHash);
    return c.json({ ...result, meta: { subreddit: name, sort, time, limit, proxy: { ip, country: proxy.country, host: proxy.host, type: 'mobile' } }, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) { return c.json({ error: 'Subreddit fetch failed', message: err?.message || String(err) }, 502); }
});

serviceRouter.get('/reddit/thread/*', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/reddit/thread/:permalink', 'Fetch post comments via mobile proxy', REDDIT_COMMENTS_PRICE, walletAddress, {
      input: { permalink: 'string (required, in path) — Reddit post permalink (e.g., r/programming/comments/abc123/title)', sort: '"best"|"top"|"new"|"controversial"|"old" (default: "best")', limit: 'number (default: 50, max: 200)' },
      output: { post: 'RedditPost', comments: 'RedditComment[] — { author, body, score, createdUtc, depth, replies }' },
    }), 402);
  }
  const verification = await verifyPayment(payment, walletAddress, REDDIT_COMMENTS_PRICE);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);
  const permalink = c.req.path.replace('/api/reddit/thread/', '');
  if (!permalink || !permalink.includes('comments')) return c.json({ error: 'Invalid permalink — must contain "comments" segment' }, 400);
  const sort = c.req.query('sort') || 'best';
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '50') || 50, 1), 200);
  try {
    const proxy = getProxy(); const ip = await getProxyExitIp();
    const result = await getComments(permalink, sort, limit);
    c.header('X-Payment-Settled', 'true'); c.header('X-Payment-TxHash', payment.txHash);
    return c.json({ ...result, meta: { permalink, sort, limit, proxy: { ip, country: proxy.country, host: proxy.host, type: 'mobile' } }, payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, settled: true } });
  } catch (err: any) { return c.json({ error: 'Comment fetch failed', message: err?.message || String(err) }, 502); }
});

// ═══════════════════════════════════════════════════════
// ─── AD VERIFICATION API (Bounty #53) ───────────────
// ═══════════════════════════════════════════════════════

serviceRouter.get('/run', async (c) => {
  const walletAddress = getWallet();
  const payment = extractPayment(c);
  const type = c.req.query('type') || 'search_ads';

  const validTypes = ['search_ads', 'display_ads', 'advertiser'];
  if (!validTypes.includes(type)) {
    return c.json({ error: 'Invalid type. Must be: search_ads | display_ads | advertiser' }, 400);
  }

  const outputSchema = {
    input: {
      type: '"search_ads"|"display_ads"|"advertiser" (required)',
      query: 'string (required for search_ads) — search query e.g. "best vpn"',
      url: 'string (required for display_ads) — webpage URL to check for display ads',
      domain: 'string (required for advertiser) — advertiser domain e.g. "nordvpn.com"',
      country: '"US"|"DE"|"FR"|"ES"|"GB"|"PL" (default: "US")',
    },
    output: {
      type: '"search_ads"|"display_ads"|"advertiser"',
      query: 'string | undefined',
      country: 'string',
      timestamp: 'ISO 8601 string',
      ads: 'EnrichedAd[] — { position, placement, title, description, displayUrl, finalUrl, advertiser, extensions, isResponsive }',
      organic_count: 'number',
      total_ads: 'number',
      ad_positions: '{ top: number, bottom: number }',
      proxy: '{ country: string, type: "mobile" }',
    },
  };

  if (!payment) {
    return c.json(build402Response(
      '/api/run',
      'Mobile Ad Verification — see what ads appear for a query or URL from any country via real 4G/5G mobile carrier IPs',
      AD_VERIFICATION_PRICE,
      walletAddress,
      outputSchema,
    ), 402);
  }

  const verification = await verifyPayment(payment, walletAddress, AD_VERIFICATION_PRICE);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);

  const country = (c.req.query('country') || 'US').toUpperCase();
  const validCountries = ['US', 'DE', 'FR', 'ES', 'GB', 'PL'];
  if (!validCountries.includes(country)) {
    return c.json({ error: `Invalid country. Supported: ${validCountries.join(', ')}` }, 400);
  }

  try {
    let result;

    if (type === 'search_ads') {
      const query = c.req.query('query');
      if (!query) return c.json({ error: 'Missing required parameter: query' }, 400);
      result = await getSearchAds(query, country, proxyFetch);
    } else if (type === 'display_ads') {
      const url = c.req.query('url');
      if (!url) return c.json({ error: 'Missing required parameter: url' }, 400);
      try { new URL(url); } catch { return c.json({ error: 'Invalid url parameter — must be a full URL' }, 400); }
      result = await getDisplayAds(url, country, proxyFetch);
    } else {
      const domain = c.req.query('domain');
      if (!domain) return c.json({ error: 'Missing required parameter: domain' }, 400);
      result = await getAdvertiserAds(domain, country, proxyFetch);
    }

    c.header('X-Payment-Settled', 'true');
    c.header('X-Payment-TxHash', payment.txHash);
    return c.json({
      ...result,
      payment: { txHash: payment.txHash, network: payment.network, amount: verification.amount, verified: true },
    });
  } catch (err: any) {
    return c.json({ error: 'Ad verification failed', message: err?.message || String(err) }, 502);
  }
});
