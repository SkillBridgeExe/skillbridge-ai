import { MODULE_METADATA } from '@nestjs/common/constants';
import { RoadmapComposerService } from '../../../src/modules/roadmap/roadmap-composer.service';
import { RoadmapModule } from '../../../src/modules/roadmap/roadmap.module';

describe('RoadmapModule exports', () => {
  it('exports RoadmapComposerService for platform adapters', () => {
    const exportsMeta = Reflect.getMetadata(MODULE_METADATA.EXPORTS, RoadmapModule) ?? [];

    expect(exportsMeta).toContain(RoadmapComposerService);
  });
});
