import { probeUrl } from './link-probe';

describe('probeUrl', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns alive:true for a 200 HEAD response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      url: 'https://x.dev/',
      headers: { get: () => 'text/html' },
    });
    const r = await probeUrl('https://x.dev/');
    expect(r).toEqual({
      alive: true,
      status: 200,
      final_url: 'https://x.dev/',
      content_type: 'text/html',
    });
  });

  it('treats 404/410 as dead', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ status: 404, url: 'https://x.dev/', headers: { get: () => null } });
    const r = await probeUrl('https://x.dev/');
    expect(r.alive).toBe(false);
    expect(r.status).toBe(404);
  });

  it('falls back to GET when HEAD returns 405', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ status: 405, url: 'https://x.dev/', headers: { get: () => null } })
      .mockResolvedValueOnce({
        status: 200,
        url: 'https://x.dev/',
        headers: { get: () => 'text/html' },
      });
    global.fetch = fetchMock;
    const r = await probeUrl('https://x.dev/');
    expect(r.alive).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('follows a redirect (manual mode) up to 3 hops and reports the final url', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        status: 301,
        url: 'https://a.dev/',
        headers: { get: (h: string) => (h === 'location' ? 'https://b.dev/' : null) },
      })
      .mockResolvedValueOnce({
        status: 200,
        url: 'https://b.dev/',
        headers: { get: () => 'text/html' },
      });
    global.fetch = fetchMock;
    const r = await probeUrl('https://a.dev/');
    expect(r.status).toBe(200);
    expect(r.final_url).toBe('https://b.dev/');
  });

  it('treats an unresolved redirect chain beyond the hop cap as dead, not alive:true on a 3xx', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        status: 302,
        url: 'https://a.dev/',
        headers: { get: (h: string) => (h === 'location' ? 'https://b.dev/' : null) },
      })
      .mockResolvedValueOnce({
        status: 302,
        url: 'https://b.dev/',
        headers: { get: (h: string) => (h === 'location' ? 'https://c.dev/' : null) },
      })
      .mockResolvedValueOnce({
        status: 302,
        url: 'https://c.dev/',
        headers: { get: (h: string) => (h === 'location' ? 'https://d.dev/' : null) },
      })
      .mockResolvedValueOnce({
        status: 302,
        url: 'https://d.dev/',
        headers: { get: (h: string) => (h === 'location' ? 'https://e.dev/' : null) },
      });

    global.fetch = fetchMock;

    const r = await probeUrl('https://a.dev/');

    expect(r.alive).toBe(false);
    expect(r.status).toBe(302);
    expect(r.final_url).toBe('https://e.dev/');
  });

  it('a network error yields a null-status dead result, never throws', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
    const r = await probeUrl('https://x.dev/');
    expect(r).toEqual({
      alive: false,
      status: null,
      final_url: 'https://x.dev/',
      content_type: null,
    });
  });
});
