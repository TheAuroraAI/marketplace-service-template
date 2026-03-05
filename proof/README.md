# LinkedIn Enrichment API — Proof of Work

## Proxy Purchase (On-Chain)

- **Transaction**: [`0xc41c873b...`](https://basescan.org/tx/0xc41c873b12ef3e2dc0769b356a16d67624ffaccc688f6482fac2f4e3a56052ef)
- **Network**: Base L2
- **Amount**: $0.40 USDC
- **Provider**: Proxies.sx
- **Exit IP**: `172.56.168.236` — T-Mobile US 4G carrier

## Live Endpoints

All endpoints return HTTP 402 before payment (correct x402 behavior):

```bash
curl https://marketplace-api-9kvb.onrender.com/api/linkedin/person?url=linkedin.com/in/satyanadella
curl https://marketplace-api-9kvb.onrender.com/api/linkedin/company?url=linkedin.com/company/microsoft
curl "https://marketplace-api-9kvb.onrender.com/api/linkedin/search/people?title=CTO&location=San+Francisco"
curl https://marketplace-api-9kvb.onrender.com/api/linkedin/company/google/employees?title=engineer
```

## Proof Files

- `linkedin-proxy-verification.json` — Proxy purchase receipt + connection test
- `sample-people.json` — 10 LinkedIn profile extractions
- `sample-companies.json` — 5 company profile extractions
- `sample-search.json` — People search with filters

## Pricing

| Endpoint | Price |
|---|---|
| Person profile | $0.03 USDC |
| Company profile | $0.05 USDC |
| People search | $0.10 USDC |
| Company employees | $0.10 USDC |

**Solana Wallet**: `GpXHXs5KfzfXbNKcMLNbAMsJsgPsBE7y5GtwVoiuxYvH`
