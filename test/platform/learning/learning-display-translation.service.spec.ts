import { ConfigService } from '@nestjs/config';
import { LearningDisplayTranslationService } from '../../../src/platform/learning/learning-display-translation.service';

describe('LearningDisplayTranslationService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('translates each field independently instead of stopping after a local title match', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ translatedText: 'Nội dung đã dịch' }),
    } as Response);
    const config = {
      get: jest.fn((key: string) => {
        if (key === 'learning.translation.libreUrl') return 'http://localhost:5000';
        if (key === 'learning.translation.timeoutMs') return 5000;
        return undefined;
      }),
    };
    const service = new LearningDisplayTranslationService(config as unknown as ConfigService);

    const result = await service.translate({
      locale: 'vi',
      title: 'React Quick Start',
      summary: 'Learn components and state.',
    });

    expect(result).toEqual({
      locale: 'vi',
      title: 'Bắt đầu nhanh với React',
      summary: 'Nội dung đã dịch',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual(
      expect.objectContaining({
        q: 'Learn components and state.',
        source: 'en',
        target: 'vi',
      }),
    );
  });

  it('returns the original field when the translation provider times out', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('timeout'));
    const config = {
      get: jest.fn((key: string) =>
        key === 'learning.translation.libreUrl' ? 'http://localhost:5000' : undefined,
      ),
    };
    const service = new LearningDisplayTranslationService(config as unknown as ConfigService);

    await expect(
      service.translate({ locale: 'vi', summary: 'Original English text' }),
    ).resolves.toEqual({
      locale: 'vi',
      summary: 'Original English text',
    });
  });

  it('applies the configured timeout to the Google Translate request', async () => {
    const request = jest.fn().mockResolvedValue({
      data: { translations: [{ translatedText: 'Nội dung đã dịch' }] },
    });
    const config = {
      get: jest.fn((key: string) => {
        if (key === 'learning.translation.googleEnabled') return true;
        if (key === 'learning.translation.googleProjectId') return 'skillbridge-test';
        if (key === 'learning.translation.timeoutMs') return 4321;
        return undefined;
      }),
    };
    const service = new LearningDisplayTranslationService(config as unknown as ConfigService);
    Object.defineProperty(service, 'googleAuth', {
      value: { getClient: jest.fn().mockResolvedValue({ request }) },
    });

    await expect(
      service.translate({ locale: 'vi', summary: 'Original English text' }),
    ).resolves.toEqual({
      locale: 'vi',
      summary: 'Nội dung đã dịch',
    });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        timeout: 4321,
      }),
    );
  });
});
