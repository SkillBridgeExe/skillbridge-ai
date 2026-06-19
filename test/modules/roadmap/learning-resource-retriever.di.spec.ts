import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { LearningResourceRetriever } from '../../../src/modules/roadmap/learning-resource-retriever.service';
import { LearningResourceMatcherService } from '../../../src/modules/roadmap/learning-resource-matcher.service';
import { LlmService } from '../../../src/infrastructure/llm/llm.service';
import { DatabaseService } from '../../../src/infrastructure/database/database.service';

/**
 * Module-level DI test (Codex review): the unit specs construct LearningResourceRetriever with `new`,
 * which can't catch a missing/incorrect Nest provider wiring. This resolves it through the real Nest
 * container with its four injected dependencies — if a constructor token is wrong or unregistered, compile() throws.
 */
describe('LearningResourceRetriever DI wiring', () => {
  it('resolves from the Nest container with its injected dependencies', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        LearningResourceRetriever,
        LearningResourceMatcherService,
        { provide: LlmService, useValue: { embed: jest.fn() } },
        { provide: DatabaseService, useValue: { query: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn() } },
      ],
    }).compile();

    expect(moduleRef.get(LearningResourceRetriever)).toBeInstanceOf(LearningResourceRetriever);
  });
});
