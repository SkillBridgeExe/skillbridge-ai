import { ItviecCrawlerService } from '../../../../src/modules/jobs/crawl/itviec-crawler.service';

/**
 * Expiry-guard regression spec (2026-07-06 pool-collapse incident): between 06-26 and 07-02 the
 * sitemap chain was unreachable from the cron runner (Cloudflare), discovery silently fell back
 * to the listing sweep (~6 newest slugs) and expireStale() then expired 1,387 jobs — the entire
 * pool — because absence from a PARTIAL inventory was treated as evidence of death.
 * Rule pinned here: expiry may only run on a COMPLETE sitemap inventory.
 */
describe('ItviecCrawlerService expiry guard', () => {
  const ROBOTS = 'User-Agent: *\nAllow: /\nSitemap: https://itviec.com/index.xml';
  const INDEX =
    '<sitemapindex><sitemap><loc>https://itviec.com/jobs_desc_en.xml</loc></sitemap>' +
    '<sitemap><loc>https://itviec.com/jobs_desc_vn.xml</loc></sitemap></sitemapindex>';
  const sub = (slug: string) =>
    `<urlset><url><loc>https://itviec.com/it-jobs/${slug}</loc></url></urlset>`;

  const res = (ok: boolean, body = '', status = ok ? 200 : 403) =>
    ({ ok, status, text: () => Promise.resolve(body) }) as unknown as Response;

  function build() {
    const config = { get: jest.fn() };
    const ingest = {
      ingestBatch: jest.fn().mockResolvedValue({
        inserted: 0,
        updated: 0,
        skipped_no_skills: 0,
        errors: [],
      }),
      expireStale: jest.fn().mockResolvedValue(0),
    };
    const db = { query: jest.fn().mockResolvedValue([]) };
    const service = new ItviecCrawlerService(
      config as never,
      ingest as never,
      db as never,
    );
    // politeFetch is rate-limited real fetch — stub it per-URL in each test.
    const fetchMock = jest.fn();
    (service as unknown as { politeFetch: unknown }).politeFetch = fetchMock;
    return { service, ingest, db, fetchMock };
  }

  it('full sitemap inventory → expireStale runs (ghost-job hygiene intact)', async () => {
    const { service, ingest, fetchMock } = build();
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('robots.txt')) return Promise.resolve(res(true, ROBOTS));
      if (url.endsWith('index.xml')) return Promise.resolve(res(true, INDEX));
      if (url.includes('jobs_desc_en')) return Promise.resolve(res(true, sub('backend-dev-4501')));
      if (url.includes('jobs_desc_vn')) return Promise.resolve(res(true, sub('frontend-dev-4502')));
      return Promise.resolve(res(false, '', 404)); // detail fetches: gone
    });
    const summary = await service.crawl(0);
    expect(summary.discovery).toBe('sitemap');
    expect(ingest.expireStale).toHaveBeenCalledTimes(1);
  });

  it('listing fallback (sitemap unreachable) → expiry SKIPPED: partial view proves nothing', async () => {
    const { service, ingest, fetchMock } = build();
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('robots.txt')) return Promise.resolve(res(true, ROBOTS));
      if (url.endsWith('index.xml')) return Promise.resolve(res(false)); // Cloudflare 403
      // listing pages: one slug visible
      return Promise.resolve(res(true, '<a href="/it-jobs/newest-job-9001">x</a>'));
    });
    const summary = await service.crawl(0);
    expect(summary.discovery).toBe('listing');
    expect(ingest.expireStale).not.toHaveBeenCalled();
  });

  it('sitemap with a FAILED sub-sitemap → inventory incomplete → expiry SKIPPED', async () => {
    const { service, ingest, fetchMock } = build();
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('robots.txt')) return Promise.resolve(res(true, ROBOTS));
      if (url.endsWith('index.xml')) return Promise.resolve(res(true, INDEX));
      if (url.includes('jobs_desc_en')) return Promise.resolve(res(true, sub('backend-dev-4501')));
      if (url.includes('jobs_desc_vn')) return Promise.resolve(res(false)); // half the pool invisible
      return Promise.resolve(res(false, '', 404));
    });
    const summary = await service.crawl(0);
    expect(summary.discovery).toBe('sitemap');
    expect(ingest.expireStale).not.toHaveBeenCalled();
  });
});
