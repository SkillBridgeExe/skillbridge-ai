import { ValidationPipe } from '@nestjs/common';
import { CvListQueryDto } from '../../../src/platform/cvs/dto/cv-list-query.dto';

describe('CvListQueryDto', () => {
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  const metadata = { type: 'query', metatype: CvListQueryDto, data: '' } as const;

  it('accepts and transforms a supported cvKind filter', async () => {
    await expect(
      pipe.transform({ page: '2', limit: '5', cvKind: 'BUILT' }, metadata),
    ).resolves.toMatchObject({ page: 2, limit: 5, cvKind: 'BUILT' });
  });

  it('rejects an unsupported cvKind filter', async () => {
    await expect(
      pipe.transform({ page: '1', limit: '20', cvKind: 'OTHER' }, metadata),
    ).rejects.toThrow();
  });
});
