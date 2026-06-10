import { Injectable, Logger } from '@nestjs/common';
import { SkillNormalizerService } from '../../common/services/skill-normalizer.service';
import { SkillTextScannerService } from '../../common/services/skill-text-scanner.service';
import { CvReviewParsedResponse } from '../cv-review/dto/cv-review-response.dto';
import {
  GithubClientService,
  GithubRateLimitError,
  GithubUserNotFoundError,
} from './github-client.service';
import { buildGithubEvidence, GithubSkillEvidence } from './github-evidence';

const USERNAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;

export type GithubEvidenceDto =
  | {
      available: true;
      username: string;
      analyzed_repo_count: number;
      /** false = CV has no review/ledger yet → corroborated is empty by construction. */
      cv_skill_join: boolean;
      corroborated: GithubSkillEvidence[];
      github_only: GithubSkillEvidence[];
    }
  | {
      available: false;
      reason: 'CONSENT_REQUIRED' | 'INVALID_USERNAME' | 'USER_NOT_FOUND' | 'RATE_LIMITED' | 'FETCH_FAILED';
    };

/**
 * Opt-in GitHub evidence (username + consent — NO OAuth in v1, decided 2026-06-10).
 * Deterministic, display-only, never-throw for expected conditions. Exported for the platform
 * route GET /api/cvs/:cvId/github-evidence (Tuấn). Honest: evidence is tied to the handle the
 * USER provided — copy never says "verified".
 */
@Injectable()
export class GithubEvidenceService {
  private readonly logger = new Logger(GithubEvidenceService.name);

  constructor(
    private readonly client: GithubClientService,
    private readonly normalizer: SkillNormalizerService,
    private readonly scanner: SkillTextScannerService,
  ) {}

  async build(input: {
    username: string;
    consent: boolean;
    review: CvReviewParsedResponse | null;
    lang?: 'vi' | 'en';
  }): Promise<GithubEvidenceDto> {
    if (!input.consent) return { available: false, reason: 'CONSENT_REQUIRED' };
    const username = (input.username ?? '').trim();
    if (!USERNAME_RE.test(username)) return { available: false, reason: 'INVALID_USERNAME' };

    let repos;
    try {
      repos = await this.client.fetchPublicRepos(username);
    } catch (err) {
      if (err instanceof GithubUserNotFoundError) return { available: false, reason: 'USER_NOT_FOUND' };
      if (err instanceof GithubRateLimitError) return { available: false, reason: 'RATE_LIMITED' };
      this.logger.warn(`github evidence fetch failed for a user: ${String(err)}`);
      return { available: false, reason: 'FETCH_FAILED' };
    }

    const ledgerItems = input.review?.evidence_ledger?.items;
    const cvCanonicals = ledgerItems ? new Set(ledgerItems.map((i) => i.skill_canonical)) : null;
    const { corroborated, github_only, analyzed_repo_count } = buildGithubEvidence(
      repos,
      cvCanonicals,
      (raw) =>
        this.normalizer.normalizeMention(raw).find((r) => r.canonical_name !== null)
          ?.canonical_name ?? null,
      (text) => this.scanner.scan(text),
      (c) => this.normalizer.getByCanonical(c)?.display_name ?? c,
      input.lang ?? 'vi',
    );
    this.logger.log(`github evidence: ${analyzed_repo_count} repos analyzed for cv join=${cvCanonicals !== null}`);
    return {
      available: true,
      username,
      analyzed_repo_count,
      cv_skill_join: cvCanonicals !== null,
      corroborated,
      github_only,
    };
  }
}
