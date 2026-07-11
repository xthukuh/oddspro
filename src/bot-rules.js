// Known scraper / AI-agent / generic HTTP-client user agents (pure, zero
// imports - offline-testable). Lowercase substrings matched against the request
// UA. Deliberately EXCLUDES general search engines (Googlebot/Bingbot/etc.) so
// SEO indexing of the public landing page is unaffected; tune per deployment
// with BOT_UA_EXTRA (add) / BOT_UA_ALLOW (exempt).
export const BOT_UA_PATTERNS = [
    // AI crawlers / LLM scrapers ("clever anti-ai-agent scraping")
    'gptbot', 'oai-searchbot', 'chatgpt-user', 'claudebot', 'anthropic-ai', 'claude-web',
    'ccbot', 'google-extended', 'perplexitybot', 'perplexity-user', 'bytespider', 'amazonbot',
    'applebot-extended', 'cohere-ai', 'diffbot', 'omgili', 'omgilibot', 'meta-externalagent',
    'imagesiftbot', 'youbot', 'timpibot', 'friendlycrawler', 'webzio', 'awariobot', 'petalbot',
    // aggressive commercial SEO crawlers
    'ahrefsbot', 'semrushbot', 'mj12bot', 'dotbot', 'dataforseobot', 'blexbot', 'serpstatbot', 'megaindex',
    // generic HTTP libraries / headless automation (not real browsers)
    'python-requests', 'python-urllib', 'scrapy', 'curl/', 'wget/', 'go-http-client', 'node-fetch',
    'axios/', 'okhttp', 'java/', 'libwww-perl', 'httpclient', 'guzzlehttp', 'aiohttp',
    'headlesschrome', 'phantomjs', 'puppeteer', 'playwright',
];

// True when the UA is a known bot we want to block. An empty/absent UA is NOT
// blocked here (many benign clients omit it; the human-token gate still stops
// tokenless callers) - callers decide how to treat missing UAs separately.
export function isBlockedUserAgent(ua, { extra = [], allow = [] } = {}) {
    if (typeof ua !== 'string' || ua === '') return false;
    const s = ua.toLowerCase();
    if (allow.some(a => a && s.includes(String(a).toLowerCase()))) return false;
    for (const p of BOT_UA_PATTERNS) if (s.includes(p)) return true;
    for (const p of extra) if (p && s.includes(String(p).toLowerCase())) return true;
    return false;
}

// robots.txt body: politely disallow AI crawlers + the API surface (the impolite
// ones that ignore this are caught by isBlockedUserAgent). Served by the API
// server at /robots.txt.
export const AI_ROBOTS_TXT = [
    '# oddspro - data behind a human-verification gate; AI crawlers disallowed.',
    ...['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'anthropic-ai', 'Claude-Web',
        'CCBot', 'Google-Extended', 'PerplexityBot', 'Perplexity-User', 'Bytespider', 'Amazonbot',
        'Applebot-Extended', 'cohere-ai', 'Diffbot', 'Omgilibot', 'meta-externalagent', 'PetalBot',
        'AhrefsBot', 'SemrushBot', 'MJ12bot', 'DotBot', 'DataForSeoBot']
        .map(a => `User-agent: ${a}\nDisallow: /`),
    '',
    'User-agent: *',
    'Disallow: /api/',
    '',
].join('\n');
