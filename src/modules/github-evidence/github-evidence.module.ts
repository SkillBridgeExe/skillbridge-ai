import { Module } from '@nestjs/common';
import { GithubClientService } from './github-client.service';
import { GithubEvidenceService } from './github-evidence.service';

/** Opt-in GitHub evidence (public API, username+consent). Exported for the platform route. */
@Module({
  providers: [GithubClientService, GithubEvidenceService],
  exports: [GithubEvidenceService],
})
export class GithubEvidenceModule {}
