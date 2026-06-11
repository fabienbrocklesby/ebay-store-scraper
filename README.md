# eBay store scraper (Zyte)

Two layers in one repo:

1. **The engine** (`engine/scrape.ts`): a battle-tested CLI that scrapes every product
   from a list of eBay stores into CSV, using the Zyte API purely as a fetch
   layer. Every page is pulled as raw HTML and parsed by our own code. No AI
   extraction anywhere; eBay's pages are templated, so plain parsing is faster,
   cheaper, and (for brand/MPN) more accurate.
2. **The web app** (`web/`): a simple password-protected site where a
   non-developer uploads a store list, presses Start, watches friendly
   progress, and downloads the CSVs. It never imports the engine: each job
   spawns the proven CLI as a subprocess in its own folder.

## The web app

```
upload stores.txt ──> file checked, line-numbered errors if anything is off
       │
       └─ Start ──> job runs server-side (close the tab, come back anytime)
                      "Finding products in 112 stores..."
                      "Collecting product details: 12,400 of 329,000 (4%), about 5 hours left"
                      │
                      └─ Finished ──> products_1.csv, products_2.csv, ... to download
```

What it guarantees:

- **The file is validated before anything starts.** Accepted lines:
  `https://www.ebay.com/str/storename`, eBay seller-search links
  (`/sch/i.html?_ssn=seller&...`), and bare slugs; trailing slashes, query
  strings, and missing scheme/www are tolerated and normalized. Anything else
  is rejected with its line number. No job is created from a bad file.
- **One job runs at a time.** The Zyte account and its 3,000 requests/min cap
  are shared, so further jobs queue FIFO ("Waiting in line behind 1 other job").
- **Nothing is ever lost.** The engine checkpoints everything in SQLite. If
  the server restarts mid-job, the job shows as interrupted with a Resume
  button; resuming re-spawns the same CLI in the same folder and it continues
  where it stopped. Stop, crash, redeploy: all safe.
- **Spending limits are there, but out of the way.** Jobs run with no limit by
  default. An optional per-run limit in dollars lives under Technical details
  on the job page (converted to the engine's request budget via
  `COST_PER_1K_USD`), and `MAX_REQUESTS_PER_JOB` can set a server-wide default.
  A job that hits its limit is shown honestly ("Stopped at the spending safety
  limit") and resumes with a fresh allowance.
- **Failures are surfaced, never hidden.** Stores or products that could not
  be fetched are counted on the job page and retried on resume.

### Run it locally

```bash
cp .env.example .env        # fill in APP_PASSWORD and ZYTE_API_KEY
docker compose up --build   # open http://localhost:8000
```

Or without Docker (uses the prebuilt static/styles.css checked into the repo):

```bash
deno task serve             # reads .env, open http://localhost:8000
```

### Environment variables

| Variable               | Default    | Meaning                                                                                                                    |
| ---------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------- |
| `APP_PASSWORD`         | (required) | Shared password for the whole app. The server refuses to start without it, because the Start button spends real money.     |
| `ZYTE_API_KEY`         | (required) | Zyte API key from app.zyte.com. The server refuses to start without it. Blank counts as unset.                             |
| `PORT`                 | `8000`     | HTTP port.                                                                                                                 |
| `DATA_DIR`             | `./jobs`   | One folder per job (stores file, SQLite DB, log, CSVs). Mount a persistent volume here.                                    |
| `MAX_REQUESTS_PER_JOB` | (unset)    | Optional default per-run budget stop for new jobs, in requests. Unset means no limit; jobs can set their own in the app.   |
| `SCRAPE_CONCURRENCY`   | `160`      | Parallel requests per job. 160 is the validated sweet spot (~1.6M products/day).                                           |
| `COST_PER_1K_USD`      | `0.12`     | Measured blended $ per 1,000 requests; converts the app's dollar limits to request budgets. Re-measure after plan changes. |
| `SCRAPE_EXTRA_ARGS`    | (empty)    | Test-only extra engine flags, e.g. `--cap=4`. See TESTING.md.                                                              |

## Deploying on Dokploy

1. Push this repo to a Git remote Dokploy can reach.
2. Create an **Application** in Dokploy from that repo.
   - **Build type:** Dockerfile (path `./Dockerfile`, context `.`).
3. **Environment** tab, add:
   - `APP_PASSWORD` = the shared password for whoever runs scrapes
   - `ZYTE_API_KEY` = the Zyte key (required; the code contains no key)
   - `MAX_REQUESTS_PER_JOB` = optional default per-run spend stop; leave unset
     for no limit (jobs can set their own in the app)
4. **Advanced -> Volumes**, add a **Volume Mount**:
   - Mount path: `/data`
   - This is everything: jobs, databases, and CSVs live here and must survive
     redeploys. Without it a redeploy orphans all job history.
5. **Domains** tab: add the domain, port `8000`, HTTPS on.
6. Health check path (if you configure one): `/healthz`.
7. Deploy. Redeploys are safe mid-job: the running job is marked interrupted
   and shows a Resume button, and resuming loses nothing.

## The engine: three layers

```
data/stores_all.txt ──> scrape ──────> data/scrape.db ──> export ──> data/products_*.csv
                          │
                          ├─ (default)  listing: title, price, currency, image, URL
                          │              ~1 request per 240 products
                          ├─ --desc     + seller description
                          │              1 request per product (cheap desc host)
                          └─ --full     + item specifics (brand, MPN, fitment...),
                                         stock count, all gallery images, description
                                         2 requests per product
```

The design is built around one fact: a search results page carries up to **240
products per request**, while an item page carries 1. So the scraper works in
cheap-to-expensive layers and you only pay for the depth you need. The web app
always runs `--full`: complete product data is its whole point.

Everything lands in SQLite first (`data/scrape.db`, the source of truth), and
the CSV is exported at the end of every run. Every run is resumable: stop it,
crash it, hit the budget stop, then re-run and it continues where it left off.

### Engine quick start (CLI, without the web app)

```bash
cd ~/Code/general-projects/ebay-scraper-zyte
cp .env.example .env    # fill in ZYTE_API_KEY; the scrape task reads .env

deno task test          # unit tests, free, no network
deno task scrape        # listing pass over every store in data/stores_all.txt
deno task scrape --full --max-requests=800000   # full data for everything
deno task export        # re-export CSV from the database any time
```

All flags, monitoring commands, cost controls, and smoke-test recipes are in
**[TESTING.md](TESTING.md)**.

## Cost model (June 2026, verify in your Zyte dashboard)

eBay is Zyte tier 2: about **$0.23 per 1,000 raw requests** pay-as-you-go,
before commitment-plan discounts (40-52% at $200-500/month). Measured live
(June 2026, on a $100/month commitment tier): **~$0.12 per 1,000 blended**
across ebay.com and itm.ebaydesc.com, so full data lands near **$240 per 1M
products**. Per 1M products:

| Layer          | Requests | PAYG      | At $350-500/mo commitment |
| -------------- | -------- | --------- | ------------------------- |
| Listing        | ~4,200   | ~$1       | < $1                      |
| + descriptions | ~1M      | ~$135-235 | ~$70-120                  |
| + full data    | ~2M      | ~$360-460 | **~$175-240**             |

Two costs to respect:

- **PAYG spending cap is $100 total**; the account suspends when it's hit. The
  budget stop (`--max-requests` / `MAX_REQUESTS_PER_JOB`) halts cleanly first.
- **Speed is NOT a plan feature.** Every plan gets 3000 requests/minute; more
  is a free support ticket. The real ceiling is Zyte's per-domain limit on
  ebay.com, which the scraper adapts to by pausing the whole pool on any
  429/over-domain-limit response.

## How it stays correct

- **eBay's ~10k search ceiling:** a store search stops serving past ~10k
  results. Any price band yielding 9,000+ items is split in half (`_udlo` /
  `_udhi`) and re-walked until every band fits. Verified live: stores with
  12-19k items captured in full.
- **Two page layouts:** eBay serves search results as `s-card` lists and store
  pages as `str-item-card` articles. Both are parsed; if a seller's search
  returns nothing (slug isn't the username, or geo-filtered results), the
  scraper falls back to walking the store page itself.
- **Placeholder filtering:** eBay pads sparse results with a fake "Shop on
  eBay" card (item id 123456). Dropped.
- **Descriptions** live on a separate lightly-protected host
  (`itm.ebaydesc.com/itmdesc/{item_id}`), one fast raw request each, with its
  own rate-limit bucket.
- **Stores vs failures:** a store is `empty` only on a clean zero; any fetch
  error marks it `failed` and it is retried next run. Same for products.

## Design calls in the web layer (and why)

- **Jobs are subprocesses, not imports.** The engine stays untouched and
  proven; a wedged job can be killed without touching the server; each job's
  state is one self-contained folder.
- **Progress comes from parsing the engine's log lines**, not from
  instrumenting the engine. The lines are stable and machine-readable, and the
  log doubles as a debugging artifact per job (`{job}/run.log`).
- **htmx polling, not websockets.** A scrape runs for hours; a 3-second poll
  of a tiny HTML fragment is plenty and survives proxies, redeploys, and
  laptop sleep with zero machinery.
- **One shared password, not accounts.** The audience is a small trusted
  team. The session cookie is salted per server boot, so a restart logs
  everyone out (they just log back in).
- **Queued jobs auto-start; interrupted jobs need a click.** Queued means a
  human already pressed Start, so the queue keeps moving after a restart.
  Interrupted jobs wait for a human Resume as a deliberate spending gate.
- **No limit by default, limits on request.** The primary flow never mentions
  budgets; the optional per-run dollar limit sits under Technical details ->
  Advanced for whoever wants the guard rail.
- **Tailwind via standalone CLI, htmx vendored.** No npm anywhere. A prebuilt
  `static/styles.css` is checked in for local dev; the Docker build regenerates
  it from source.

## Files

| Path                         | What it is                                                     |
| ---------------------------- | -------------------------------------------------------------- |
| `engine/scrape.ts`           | the engine: flags, phases, walker, SQLite, CSV export          |
| `engine/zyte.ts`             | Zyte fetch client: budget stop, pool-wide backoff, retries     |
| `engine/parse.ts`            | pure HTML parsers for the three eBay page types                |
| `engine/export.ts`           | re-export CSV from the database without scraping               |
| `web/server.ts`              | the web app: routes, auth, static files                        |
| `web/jobs.ts`                | job folders, subprocess spawning, FIFO queue, restart recovery |
| `web/validate.ts`            | stores-file validation and normalization                       |
| `web/progress.ts`            | engine log parsing and friendly status text                    |
| `web/views.ts`               | server-rendered HTML templates                                 |
| `static/`                    | vendored htmx + prebuilt Tailwind CSS                          |
| `Dockerfile`, `compose.yaml` | deployment; see Dokploy section above                          |
| `*_test.ts`                  | unit tests (`deno task test`)                                  |
| `TESTING.md`                 | commands: testing, monitoring, costs, resets                   |
