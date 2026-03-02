/**
 * X/Twitter Intelligence Scraper
 * ────────────────────────────────
 * Primary:  Twitter v2 API (requires TWITTER_BEARER_TOKEN env var)
 * Fallback: Twitter Syndication API (profile timelines, no auth)
 *
 * Supports: tweet search, user profiles, user timelines, trending topics
 */

// ─── TYPES ──────────────────────────────────────────

export type ProxyFetchFn = (
  url: string,
  options?: RequestInit & { maxRetries?: number; timeoutMs?: number },
) => Promise<Response>;

export interface TweetResult {
  id: string;
  author: { handle: string; name: string; verified: boolean };
  text: string;
  created_at: string;
  likes: number;
  retweets: number;
  replies: number;
  url: string;
  hashtags: string[];
}

export interface TrendingTopic {
  name: string;
  tweet_count: number | null;
  category: string | null;
  url: string;
}

export interface XUserProfile {
  handle: string;
  name: string;
  bio: string;
  location: string;
  followers: number;
  following: number;
  tweets_count: number;
  verified: boolean;
  joined: string;
  profile_image: string;
  banner_image: string;
}

export interface ThreadTweet {
  id: string;
  author: { handle: string; name: string };
  text: string;
  created_at: string;
  likes: number;
  retweets: number;
  replies: number;
}

// ─── CONSTANTS ──────────────────────────────────────

const TWITTER_V2_BASE = 'https://api.twitter.com/2';
const SYNDICATION_BASE = 'https://syndication.twitter.com';
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_QUERY_LEN = 512;
const MAX_HANDLE_LEN = 50;
const MAX_TWEET_ID_LEN = 30;

// ─── UTILITIES ──────────────────────────────────────

function getBearerToken(): string | null {
  return process.env.TWITTER_BEARER_TOKEN ?? null;
}

function sanitize(value: string | null | undefined, maxLen: number): string {
  if (!value) return '';
  return value.replace(/[\r\n\0]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function safeInt(v: unknown): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? 0), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function extractHashtags(text: string): string[] {
  return [...text.matchAll(/#([a-zA-Z0-9_]+)/g)].map(m => m[1]).slice(0, 10);
}

function normalizeDate(raw: string | undefined): string {
  if (!raw) return '';
  try {
    return new Date(raw).toISOString();
  } catch {
    return raw;
  }
}

// ─── TWITTER V2 API HELPERS ─────────────────────────

interface V2Tweet {
  id: string;
  text: string;
  created_at?: string;
  author_id?: string;
  public_metrics?: { like_count?: number; retweet_count?: number; reply_count?: number };
  entities?: { hashtags?: Array<{ tag: string }> };
  conversation_id?: string;
}

interface V2User {
  id: string;
  name: string;
  username: string;
  description?: string;
  location?: string;
  public_metrics?: { followers_count?: number; following_count?: number; tweet_count?: number };
  verified?: boolean;
  created_at?: string;
  profile_image_url?: string;
}

async function v2Fetch(
  path: string,
  _proxyFetch: ProxyFetchFn | undefined,
): Promise<Response> {
  const token = getBearerToken();
  if (!token) throw new Error('TWITTER_BEARER_TOKEN not set');
  return fetch(`${TWITTER_V2_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'v2TweetSearchJS',
    },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
}

function tweetToResult(tweet: V2Tweet, authorMap: Map<string, V2User>): TweetResult {
  const user = authorMap.get(tweet.author_id ?? '');
  const handle = sanitize(user?.username, 50);
  const name = sanitize(user?.name, 100);
  const text = sanitize(tweet.text, 1000);
  const hashtagsFromEntities = (tweet.entities?.hashtags ?? []).map(h => h.tag);
  const hashtags = hashtagsFromEntities.length ? hashtagsFromEntities : extractHashtags(text);
  return {
    id: tweet.id,
    author: { handle, name, verified: user?.verified ?? false },
    text,
    created_at: normalizeDate(tweet.created_at),
    likes: safeInt(tweet.public_metrics?.like_count),
    retweets: safeInt(tweet.public_metrics?.retweet_count),
    replies: safeInt(tweet.public_metrics?.reply_count),
    url: handle ? `https://x.com/${handle}/status/${tweet.id}` : `https://x.com/i/status/${tweet.id}`,
    hashtags,
  };
}

// ─── SYNDICATION API HELPERS ─────────────────────────

async function syndicationProfileTimeline(
  handle: string,
  count: number,
  proxyFetch: ProxyFetchFn,
): Promise<{ tweets: V2Tweet[]; user: V2User | null }> {
  const url = `${SYNDICATION_BASE}/srv/timeline-profile/screen-name/${encodeURIComponent(handle)}?count=${count}`;
  const resp = await proxyFetch(url, {
    maxRetries: 2,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  });
  if (!resp.ok) throw new Error(`Syndication HTTP ${resp.status}`);
  const html = await resp.text();
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.+?)<\/script>/s);
  if (!m) throw new Error('No __NEXT_DATA__ in syndication response');
  const data = JSON.parse(m[1]) as Record<string, unknown>;
  const pageProps = (data.props as Record<string, unknown>)?.pageProps as Record<string, unknown>;
  const entries: Array<Record<string, unknown>> =
    ((pageProps?.timeline as Record<string, unknown>)?.entries as Array<Record<string, unknown>>) ?? [];
  const userRaw = pageProps?.profile as Record<string, unknown> | null;

  const tweets: V2Tweet[] = entries
    .map(e => (e.content as Record<string, unknown>)?.tweet as Record<string, unknown>)
    .filter(Boolean)
    .map(t => ({
      id: String(t.id_str ?? t.id ?? ''),
      text: sanitize(t.full_text as string, 1000),
      created_at: normalizeDate(t.created_at as string),
      author_id: String((t.user as Record<string, unknown>)?.id_str ?? ''),
      public_metrics: {
        like_count: safeInt(t.favorite_count),
        retweet_count: safeInt(t.retweet_count),
        reply_count: safeInt(t.reply_count),
      },
    }));

  let user: V2User | null = null;
  if (userRaw) {
    user = {
      id: String(userRaw.id_str ?? ''),
      name: sanitize(userRaw.name as string, 100),
      username: sanitize(userRaw.screen_name as string, 50),
      description: sanitize(userRaw.description as string, 500),
      location: sanitize(userRaw.location as string, 200),
      public_metrics: {
        followers_count: safeInt(userRaw.followers_count),
        following_count: safeInt(userRaw.friends_count),
        tweet_count: safeInt(userRaw.statuses_count),
      },
      verified: Boolean(userRaw.verified ?? false),
      created_at: normalizeDate(userRaw.created_at as string),
      profile_image_url: sanitize(
        ((userRaw.profile_image_url_https as string) ?? '').replace('_normal', '_400x400'),
        500,
      ),
    };
  }
  return { tweets, user };
}

// ─── PUBLIC API FUNCTIONS ───────────────────────────

/**
 * Search tweets by keyword, hashtag, or query string.
 * Requires TWITTER_BEARER_TOKEN env var (Twitter v2 API).
 */
export async function searchTweets(
  query: string,
  sort: 'relevancy' | 'recency' | 'latest' | 'top' = 'recency',
  limit: number,
  proxyFetch: ProxyFetchFn,
): Promise<TweetResult[]> {
  const q = sanitize(query, MAX_QUERY_LEN);
  if (!q) return [];
  const n = Math.min(Math.max(safeInt(limit) || 20, 10), 100);
  // Map legacy 'top'|'latest' aliases to v2 API sort_order values
  const sortOrder = (sort === 'relevancy' || sort === 'top') ? 'relevancy' : 'recency';

  const params = new URLSearchParams({
    query: `${q} -is:retweet lang:en`,
    max_results: String(n),
    sort_order: sortOrder,
    'tweet.fields': 'created_at,author_id,public_metrics,entities',
    expansions: 'author_id',
    'user.fields': 'name,username,verified,public_metrics',
  });
  const resp = await v2Fetch(`/tweets/search/recent?${params}`, proxyFetch);
  if (!resp.ok) {
    const errText = await resp.text().then(t => t.slice(0, 200));
    throw new Error(`Twitter v2 search HTTP ${resp.status}: ${errText}`);
  }
  const body = await resp.json() as { data?: V2Tweet[]; includes?: { users?: V2User[] } };
  const tweets = body.data ?? [];
  const users = body.includes?.users ?? [];
  const userMap = new Map<string, V2User>(users.map(u => [u.id, u]));
  return tweets.map(t => tweetToResult(t, userMap));
}

/**
 * Get trending topics on X/Twitter.
 * Uses Trends24 (aggregates Twitter trending data, publicly accessible).
 */
export async function getTrending(
  country: string,
  proxyFetch: ProxyFetchFn,
): Promise<TrendingTopic[]> {
  const cc = sanitize(country, 10).toUpperCase() || 'US';
  const countryMap: Record<string, string> = {
    US: 'united-states', GB: 'united-kingdom', CA: 'canada',
    AU: 'australia', DE: 'germany', FR: 'france', JP: 'japan',
    BR: 'brazil', IN: 'india', MX: 'mexico',
  };
  const slug = countryMap[cc] ?? 'united-states';
  const url = `https://trends24.in/${slug}/`;

  const resp = await proxyFetch(url, {
    maxRetries: 2,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    headers: {
      Accept: 'text/html',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  });
  if (!resp.ok) throw new Error(`Trends24 HTTP ${resp.status}`);
  const html = await resp.text();

  const results: TrendingTopic[] = [];
  const trendMatches = html.matchAll(/<li[^>]*><a[^>]+href="[^"]*">([^<]+)<\/a>/g);
  for (const m of trendMatches) {
    const name = sanitize(m[1], 100);
    if (!name || name.length < 2 || /^(Home|Trending|About|Terms|Privacy|Login)$/i.test(name)) continue;
    results.push({
      name: name.startsWith('#') ? name : `#${name}`,
      tweet_count: null,
      category: null,
      url: `https://x.com/search?q=${encodeURIComponent(name)}&src=trend_click`,
    });
    if (results.length >= 20) break;
  }
  return results;
}

/**
 * Get X/Twitter user profile.
 * Uses Twitter v2 API (if token set) or Syndication API fallback.
 */
export async function getUserProfile(
  handle: string,
  proxyFetch: ProxyFetchFn,
): Promise<XUserProfile> {
  const h = sanitize(handle, MAX_HANDLE_LEN).replace(/^@/, '');
  if (!h) throw new Error('Invalid handle');

  const token = getBearerToken();
  if (token) {
    const params = new URLSearchParams({
      'user.fields': 'description,location,public_metrics,verified,created_at,profile_image_url',
    });
    const resp = await v2Fetch(`/users/by/username/${encodeURIComponent(h)}?${params}`, proxyFetch);
    if (resp.ok) {
      const body = await resp.json() as { data?: V2User };
      const u = body.data;
      if (u) {
        return {
          handle: sanitize(u.username, 50),
          name: sanitize(u.name, 100),
          bio: sanitize(u.description, 500),
          location: sanitize(u.location, 200),
          followers: safeInt(u.public_metrics?.followers_count),
          following: safeInt(u.public_metrics?.following_count),
          tweets_count: safeInt(u.public_metrics?.tweet_count),
          verified: u.verified ?? false,
          joined: normalizeDate(u.created_at),
          profile_image: sanitize(u.profile_image_url, 500),
          banner_image: '',
        };
      }
    }
  }

  // Fallback: Syndication API (no auth required)
  const { user } = await syndicationProfileTimeline(h, 1, proxyFetch);
  if (!user) throw new Error(`Profile not found for @${h}`);
  return {
    handle: sanitize(user.username, 50),
    name: sanitize(user.name, 100),
    bio: sanitize(user.description, 500),
    location: sanitize(user.location, 200),
    followers: safeInt(user.public_metrics?.followers_count),
    following: safeInt(user.public_metrics?.following_count),
    tweets_count: safeInt(user.public_metrics?.tweet_count),
    verified: user.verified ?? false,
    joined: normalizeDate(user.created_at),
    profile_image: sanitize(user.profile_image_url, 500),
    banner_image: '',
  };
}

/**
 * Get recent tweets from a specific user.
 * Uses Twitter Syndication API (no auth required) with v2 fallback.
 */
export async function getUserTweets(
  handle: string,
  limit: number,
  proxyFetch: ProxyFetchFn,
): Promise<TweetResult[]> {
  const h = sanitize(handle, MAX_HANDLE_LEN).replace(/^@/, '');
  if (!h) return [];
  const n = Math.min(Math.max(safeInt(limit) || 20, 1), 100);

  // Syndication API works without auth
  try {
    const { tweets, user } = await syndicationProfileTimeline(h, n, proxyFetch);
    const authorMap = new Map<string, V2User>(user ? [[user.id, user]] : []);
    return tweets.slice(0, n).map(t => tweetToResult(t, authorMap));
  } catch {
    // Fallback to v2 API
    const token = getBearerToken();
    if (!token) throw new Error('Syndication unavailable; set TWITTER_BEARER_TOKEN for v2 fallback');
    const userResp = await v2Fetch(`/users/by/username/${encodeURIComponent(h)}`, proxyFetch);
    if (!userResp.ok) throw new Error(`User lookup HTTP ${userResp.status}`);
    const { data: userData } = await userResp.json() as { data?: V2User };
    if (!userData) throw new Error(`User @${h} not found`);
    const params = new URLSearchParams({
      max_results: String(Math.min(n, 100)),
      'tweet.fields': 'created_at,public_metrics,entities',
      exclude: 'retweets,replies',
    });
    const tweetsResp = await v2Fetch(`/users/${userData.id}/tweets?${params}`, proxyFetch);
    if (!tweetsResp.ok) throw new Error(`User tweets HTTP ${tweetsResp.status}`);
    const body = await tweetsResp.json() as { data?: V2Tweet[] };
    const authorMap = new Map([[userData.id, userData]]);
    return (body.data ?? []).slice(0, n).map(t => tweetToResult(t, authorMap));
  }
}

/**
 * Get full thread/conversation from a tweet ID.
 * Requires TWITTER_BEARER_TOKEN for v2 API access.
 */
export async function getThread(
  tweetId: string,
  proxyFetch: ProxyFetchFn,
): Promise<ThreadTweet[]> {
  const tid = sanitize(tweetId, MAX_TWEET_ID_LEN).replace(/[^0-9]/g, '');
  if (!tid) throw new Error('Invalid tweet ID');

  const tweetParams = new URLSearchParams({
    'tweet.fields': 'created_at,author_id,conversation_id,public_metrics',
    expansions: 'author_id',
    'user.fields': 'name,username',
  });
  const origResp = await v2Fetch(`/tweets/${tid}?${tweetParams}`, proxyFetch);
  if (!origResp.ok) throw new Error(`Tweet lookup HTTP ${origResp.status}`);
  const origBody = await origResp.json() as { data?: V2Tweet; includes?: { users?: V2User[] } };
  const origTweet = origBody.data;
  if (!origTweet) throw new Error('Tweet not found');
  const users = origBody.includes?.users ?? [];
  const userMap = new Map<string, V2User>(users.map(u => [u.id, u]));

  const conversationId = origTweet.conversation_id ?? tid;
  const threadParams = new URLSearchParams({
    query: `conversation_id:${conversationId}`,
    max_results: '100',
    'tweet.fields': 'created_at,author_id,public_metrics',
    expansions: 'author_id',
    'user.fields': 'name,username',
  });
  const thread: ThreadTweet[] = [];
  const addToThread = (t: V2Tweet): void => {
    const r = tweetToResult(t, userMap);
    thread.push({ id: r.id, author: r.author, text: r.text, created_at: r.created_at, likes: r.likes, retweets: r.retweets, replies: r.replies });
  };
  addToThread(origTweet);

  const threadResp = await v2Fetch(`/tweets/search/recent?${threadParams}`, proxyFetch);
  if (threadResp.ok) {
    const threadBody = await threadResp.json() as { data?: V2Tweet[]; includes?: { users?: V2User[] } };
    (threadBody.includes?.users ?? []).forEach(u => userMap.set(u.id, u));
    for (const t of (threadBody.data ?? [])) {
      if (t.id === tid) continue;
      addToThread(t);
    }
  }
  return thread;
}
