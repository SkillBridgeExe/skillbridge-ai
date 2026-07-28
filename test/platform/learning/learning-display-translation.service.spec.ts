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
});
