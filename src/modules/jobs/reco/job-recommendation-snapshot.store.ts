import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../../infrastructure/database/database.service';
import type { JobRecommendation } from './job-recommendation.service';

export const JOB_RECOMMENDATION_RANKING_VERSION = 'explorer-v1';

export interface JobRecommendationSnapshot {
  cv_target_role: string | null;
  recommendations: JobRecommendation[];
}

interface SnapshotRow {
  payload: JobRecommendationSnapshot | null;
}

@Injectable()
export class JobRecommendationSnapshotStore {
  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
  ) {}

  async find(
    userId: string,
    cvId: string,
    inputFingerprint: string,
  ): Promise<JobRecommendationSnapshot | null> {
    const rows = await this.db.query<SnapshotRow>(
      `SELECT payload
         FROM public.job_recommendation_snapshots
        WHERE user_id = $1
          AND cv_id = $2
          AND input_fingerprint = $3
          AND ranking_version = $4
          AND payload IS NOT NULL
          AND expires_at > now()
        LIMIT 1`,
      [userId, cvId, inputFingerprint, JOB_RECOMMENDATION_RANKING_VERSION],
    );
    return rows[0]?.payload ?? null;
  }

  async tryClaim(userId: string, cvId: string, inputFingerprint: string): Promise<string | null> {
    const leaseSeconds = Math.min(
      Math.max(Number(this.config.get<number>('jobs.recommendationBuildLeaseSeconds') ?? 120), 30),
      300,
    );
    const claimToken = randomUUID();
    const rows = await this.db.query<{ claim_token: string }>(
      `INSERT INTO public.job_recommendation_snapshots
         (user_id, cv_id, input_fingerprint, ranking_version, claim_token, payload, expires_at)
       VALUES ($1, $2, $3, $4, $5::uuid, NULL, now() + ($6 * interval '1 second'))
       ON CONFLICT (user_id, cv_id, input_fingerprint, ranking_version)
       DO UPDATE SET claim_token = EXCLUDED.claim_token,
                     payload = NULL,
                     expires_at = EXCLUDED.expires_at,
                     created_at = now()
       WHERE public.job_recommendation_snapshots.expires_at <= now()
       RETURNING claim_token`,
      [
        userId,
        cvId,
        inputFingerprint,
        JOB_RECOMMENDATION_RANKING_VERSION,
        claimToken,
        leaseSeconds,
      ],
    );
    return rows[0]?.claim_token ?? null;
  }

  async waitFor(
    userId: string,
    cvId: string,
    inputFingerprint: string,
  ): Promise<JobRecommendationSnapshot | null> {
    const waitMs = Math.min(
      Math.max(Number(this.config.get<number>('jobs.recommendationBuildWaitMs') ?? 30_000), 1_000),
      60_000,
    );
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const snapshot = await this.find(userId, cvId, inputFingerprint);
      if (snapshot) return snapshot;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return null;
  }

  async releaseClaim(
    userId: string,
    cvId: string,
    inputFingerprint: string,
    claimToken: string,
  ): Promise<void> {
    await this.db.query(
      `DELETE FROM public.job_recommendation_snapshots
        WHERE user_id = $1
          AND cv_id = $2
          AND input_fingerprint = $3
          AND ranking_version = $4
          AND claim_token = $5::uuid
          AND payload IS NULL`,
      [userId, cvId, inputFingerprint, JOB_RECOMMENDATION_RANKING_VERSION, claimToken],
    );
  }

  async save(
    userId: string,
    cvId: string,
    inputFingerprint: string,
    payload: JobRecommendationSnapshot,
    claimToken: string,
  ): Promise<boolean> {
    const ttlMinutes = Math.min(
      Math.max(Number(this.config.get<number>('jobs.recommendationSnapshotTtlMinutes') ?? 30), 5),
      240,
    );
    return this.db.transaction(async (client) => {
      const saved = await client.query(
        `UPDATE public.job_recommendation_snapshots
            SET payload = $5::jsonb,
                expires_at = now() + ($6 * interval '1 minute'),
                created_at = now()
          WHERE user_id = $1
            AND cv_id = $2
            AND input_fingerprint = $3
            AND ranking_version = $4
            AND claim_token = $7::uuid
            AND payload IS NULL
          RETURNING id`,
        [
          userId,
          cvId,
          inputFingerprint,
          JOB_RECOMMENDATION_RANKING_VERSION,
          JSON.stringify(payload),
          ttlMinutes,
          claimToken,
        ],
      );
      if ((saved.rowCount ?? 0) === 0) return false;

      await client.query(
        `DELETE FROM public.job_recommendation_snapshots
          WHERE (expires_at <= now() OR (user_id = $1 AND cv_id = $2))
            AND NOT (
              user_id = $1 AND cv_id = $2
              AND input_fingerprint = $3 AND ranking_version = $4
            )`,
        [userId, cvId, inputFingerprint, JOB_RECOMMENDATION_RANKING_VERSION],
      );
      return true;
    });
  }
}
