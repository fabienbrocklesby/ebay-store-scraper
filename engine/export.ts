// Re-dump the scraped products from data/scrape.db to the split CSV files,
// without re-scraping. Run any time: deno task export
import { exportCSV } from './scrape.ts'

exportCSV()
