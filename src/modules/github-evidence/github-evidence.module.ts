import { Module } from '@nestjs/common';
import { GithubClientService } from './github-client.service';
import { GithubEvidenceService } from './github-evidence.service';

/** Opt-in GitHub evidence (public API, username+consent). Exported for the platform route.
 *  GithubClientService is also exported for the github.enrich chat-tool adapter to reuse. */
@Module({
  providers: [GithubClientService, GithubEvidenceService],
  exports: [GithubEvidenceService, GithubClientService],
})
export class GithubEvidenceModule {}
