# Testing and operating guide

Everything runs from the project folder:

```bash
cd ~/Code/general-projects/ebay-scraper-zyte
```

Secrets live in `.env` (gitignored). One-time setup:

```bash
cp .env.example .env   # then fill in APP_PASSWORD and ZYTE_API_KEY
```

`deno task serve`, `deno task scrape`, and `docker compose up` all read `.env`
automatically. For one-off engine runs outside the repo folder, export the key
instead: `export ZYTE_API_KEY="<key from app.zyte.com>"`.

## 1. Unit tests (free, instant, no network)

```bash
deno task test
deno fmt --check && deno lint
```

40 tests cover the page parsers (both eBay layouts, placeholder filtering,
item-page fields, image scoping), the listing walker (pagination, dedup,
caps, price-band splitting, error propagation), the web app's stores-file
validation/normalization, dollar-to-request conversion, and the
engine-log-to-friendly-status mapping. Run this after ANY code change.

## 1b. The web app locally (free until you press Start)

```bash
deno task serve     # http://localhost:8000, reads .env
```

Uploading and validating a stores file is free; only Start spends requests.
For a cheap end-to-end run (~30 requests, under a cent), cap everything down
(CLI env vars override `.env`):

```bash
DATA_DIR=/tmp/web-smoke \
MAX_REQUESTS_PER_JOB=30 \
SCRAPE_EXTRA_ARGS='--cap=4' \
deno task serve
```

Upload a two-store file (pick any two real stores from eBay's store pages,
the smaller the better), press Start, and the whole job finishes in under a
minute with a downloadable `products_1.csv`. The engine prints a progress line every 25
products and at least every 2 seconds while work completes, so the page
counts up live at any speed.

To test interruption: kill the server mid-job (`Ctrl-C`), start it again, and
the job page shows "This job was interrupted" with a Resume button. Each job
lives in its own folder under `DATA_DIR` (stores file, `data/scrape.db`,
`run.log`, CSVs), so you can inspect it with the same sqlite3 commands as the
CLI.

The same flow through Docker (this is what Dokploy runs):

```bash
MAX_REQUESTS_PER_JOB=30 SCRAPE_EXTRA_ARGS=--cap=4 docker compose up --build
docker kill ebay-scraper-zyte-app-1   # simulate a hard crash mid-job
docker compose up                     # job shows Resume, nothing lost
```

`SCRAPE_EXTRA_ARGS` exists only for these smoke tests; never set it in
production. If you edit any Tailwind classes in `web/views.ts`, rebuild the
checked-in stylesheet with `deno task css` (needs the Tailwind standalone
binary at `./bin/tailwindcss`; grab it from
https://github.com/tailwindlabs/tailwindcss/releases for your platform).

## 2. Cheap live smoke test (~15 requests, under a cent)

Run against a throwaway folder so the real database is untouched:

```bash
mkdir -p /tmp/scrape-smoke/data
printf 'https://www.ebay.com/str/somestore\nhttps://www.ebay.com/str/otherstore\n' > /tmp/scrape-smoke/data/stores_all.txt
# (replace somestore/otherstore with any two real store slugs from ebay.com)
cd /tmp/scrape-smoke
deno run --allow-net --allow-read --allow-write --allow-env \
  ~/Code/general-projects/ebay-scraper-zyte/engine/scrape.ts --full --cap=4 --max-requests=14
```

Expected: both stores list a few products, full details fill in, and a clean
budget stop if the cap is hit. Inspect the output:

```bash
sqlite3 /tmp/scrape-smoke/data/scrape.db \
  "SELECT title, price, brand, mpn, availability FROM products LIMIT 5;"
open /tmp/scrape-smoke/data/products_1.csv
```

## 2b. Small tests against the REAL database

The listing phase runs first on every invocation and re-checks any store not
marked `discovered` (so restocked sellers get picked up). Each re-check costs
1-2 requests, so a tiny `--max-requests` can be consumed before `--full` even
starts. For a quick full-data test on the real database give it headroom:

```bash
deno task scrape --full --max-requests=50 --verbose   # ~25 products of full data
```

A budget stop is NOT an error. It prints `budget stop: N requests used`,
leaves every status exactly as it was, and the next run continues from there.

To stop re-checking known-dead stores (re-walk them anytime by setting them
back to `pending`):

```bash
sqlite3 data/scrape.db "UPDATE stores SET status='discovered' WHERE status='empty';"
```

## 3. The real runs

```bash
cd ~/Code/general-projects/ebay-scraper-zyte

# Listing pass: every store in data/stores_all.txt, basic fields.
# As a worked example, ~110 stores / ~330k products costs ~2,200 requests
# (about $1).
deno task scrape

# + descriptions for everything listed (1 cheap request per product):
deno task scrape --desc --max-requests=400000

# + FULL data for everything (2 requests per product):
deno task scrape --full --max-requests=800000
```

Every run is resumable: Ctrl-C, crashes, and budget stops lose nothing.
Re-running skips finished work and retries failures.

### Flags

| Flag               | Meaning                                                    | Default   |
| ------------------ | ---------------------------------------------------------- | --------- |
| `--desc`           | also fetch seller description per product                  | off       |
| `--full`           | also fetch full details per product (includes description) | off       |
| `--cap=N`          | max products per store                                     | unlimited |
| `--max-requests=N` | hard budget stop for the run                               | 25000     |
| `--concurrency=N`  | parallel requests                                          | 30        |
| `--verbose`        | log every request, its timing, and every retry/backoff     | off       |

## 4. Monitoring speed

The progress line is printed automatically during desc/full phases:

```
4200/329254 (1240/min, 8500 requests)
```

`(N/min)` is products completed per minute. For a deeper look:

```bash
# every Zyte call with seconds taken, plus every 429/ban retry and pool pause
deno task scrape --full --verbose

# run in the background and watch the log
nohup deno task scrape --full --max-requests=800000 > data/run.log 2>&1 &
tail -f data/run.log

# throughput from the database while a run is live (run repeatedly)
sqlite3 data/scrape.db "SELECT status, COUNT(*) FROM products GROUP BY status;"
```

Measured full-detail throughput (June 2026, zero pool pauses at every level):

| `--concurrency` | products/min | requests/min |
| --------------- | ------------ | ------------ |
| 30              | ~480         | ~1,000       |
| 60              | ~480-550     | ~1,000       |
| 120             | ~1,010       | ~2,000       |
| 160             | ~1,120       | ~2,350       |

Gains flatten past 120, and the account cap is 3000 requests/min, so 160 is
the sweet spot: ~1.6M products/day full data. If you see long pool pauses in
verbose output, that is the per-domain limit on ebay.com; the scraper is
handling it, but a lower `--concurrency` will pause less often. To go faster
than 3000 requests/min, open a (free) support ticket with Zyte and ask for a
raise.

## 5. Watching cost

Zyte never reports cost per request in the extract API, so:

- The request counter is printed at the end of every run and in every progress
  line. Requests are the unit of spend.
- Real billed cost: app.zyte.com -> Stats, filter by website. Divide cost by
  request count for ebay.com and itm.ebaydesc.com to get your true per-1k rates.
- There is also a Stats API: `curl -u $ZYTE_API_KEY: "https://zyte-api-stats.zyte.com/api/stats?organization_id=ORG_ID"`
  (returns request counts and cost in microUSD; the organization id is in the
  app.zyte.com URL after login).
- `--max-requests` is the safety net. Size it from the dashboard rate. The
  measured blended rate on this account (June 2026) is ~$0.12/1k, so
  `--max-requests=100000` caps a run at about $12.

As a worked example: a full-data backfill of ~330k products is ~660k
requests, roughly $85-150 depending on the commitment discount. Confirm the
real per-1k rate from the dashboard after any sizeable run before launching
the next slice.

## 6. Inspecting results

```bash
sqlite3 data/scrape.db "SELECT status, COUNT(*) FROM stores GROUP BY status;"
sqlite3 data/scrape.db "SELECT status, COUNT(*) FROM products GROUP BY status;"
sqlite3 data/scrape.db "SELECT store_name, COUNT(*) FROM products GROUP BY store_name ORDER BY 2 DESC LIMIT 15;"
sqlite3 data/scrape.db "SELECT title, price, brand, availability FROM products WHERE status='done' LIMIT 5;"
deno task export   # rebuild data/products_*.csv from the database any time
```

## 7. Resetting

```bash
rm -f data/scrape.db data/products_*.csv                                          # full reset
sqlite3 data/scrape.db "UPDATE stores SET status='pending' WHERE store_name='x';" # re-list one store
sqlite3 data/scrape.db "UPDATE products SET status='listed' WHERE status='failed';" # retry failures via --desc/--full
```
