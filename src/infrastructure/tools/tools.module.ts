import { Global, Module } from '@nestjs/common';
import { GithubEvidenceModule } from '../../modules/github-evidence/github-evidence.module';
import { ResourceValidateAdapter } from './adapters/resource-validate.adapter';
import { GithubEnrichAdapter } from './adapters/github-enrich.adapter';
import { ToolRegistry } from './tool-registry.service';

/** Same pattern as LlmModule/PromptsModule/TracingModule — @Global() so DiagnosisChatModule and
 *  LearningModule get ToolRegistry for free, zero changes to their own imports. */
@Global()
@Module({
  imports: [GithubEvidenceModule],
  providers: [ResourceValidateAdapter, GithubEnrichAdapter, ToolRegistry],
  exports: [ToolRegistry],
})
export class ToolsModule {}
