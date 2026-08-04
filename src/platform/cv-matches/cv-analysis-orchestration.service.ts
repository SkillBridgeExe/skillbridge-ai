import { HttpException, Injectable } from '@nestjs/common';
import { CvMatchResponseDto } from './dto/cv-match-response.dto';
import { CvAnalysisQuotaService } from '../cvs/cv-analysis-quota.service';
import { CvResponseDto } from '../cvs/dto/cv-response.dto';
import { CvsService } from '../cvs/cvs.service';
import { CvAnalysisRequestDto } from './dto/cv-analysis-request.dto';
import { CvMatchesService } from './cv-matches.service';

export type CvAnalysisStatus = 'ANALYZED' | 'UPLOADED_ONLY' | 'REVIEWED_ONLY';

export interface CvAnalysisResponse {
  status: CvAnalysisStatus;
  cv: CvResponseDto;
  match: CvMatchResponseDto | null;
  requiredCreditType: 'CV_ANALYSIS' | null;
  matchErrorCode?: string;
}

@Injectable()
export class CvAnalysisOrchestrationService {
  constructor(
    private readonly cvs: CvsService,
    private readonly matches: CvMatchesService,
    private readonly quota: CvAnalysisQuotaService,
  ) {}

  async analyze(
    userId: string,
    dto: CvAnalysisRequestDto,
    file?: Express.Multer.File,
  ): Promise<CvAnalysisResponse> {
    const prepared = file
      ? await this.cvs.createForAnalysis(userId, dto, file)
      : await this.cvs.rerunReviewForAnalysis(userId, dto.cvId!, dto.targetRole, dto.lang);

    if (prepared.reviewState === 'NONE' || !prepared.cv.review) {
      return {
        status: 'UPLOADED_ONLY',
        cv: prepared.cv,
        match: null,
        requiredCreditType: 'CV_ANALYSIS',
      };
    }

    const jdText = dto.jdText?.trim();
    if (!jdText) {
      await prepared.reservation?.confirm({ sourceType: 'cv', sourceId: prepared.cv.id });
      return {
        status: 'ANALYZED',
        cv: prepared.cv,
        match: null,
        requiredCreditType: null,
      };
    }

    const reservation =
      prepared.reviewState === 'CACHED'
        ? await this.quota.reserveMatch(userId)
        : prepared.reservation;
    try {
      const match = await this.matches.createMatchWithoutUsageForOrchestration(
        userId,
        prepared.cv.id,
        {
          jdText,
          title: dto.jdTitle,
          targetRole: dto.targetRole,
          targetBand: dto.targetBand,
        },
      );
      await reservation?.confirm({ sourceType: 'cv_match', sourceId: match.id });
      return {
        status: 'ANALYZED',
        cv: prepared.cv,
        match,
        requiredCreditType: null,
      };
    } catch (error) {
      if (prepared.reviewState === 'CREATED') {
        await reservation?.confirm({ sourceType: 'cv', sourceId: prepared.cv.id });
      } else {
        await reservation?.refund();
      }
      return {
        status: 'REVIEWED_ONLY',
        cv: prepared.cv,
        match: null,
        requiredCreditType: null,
        matchErrorCode: errorCode(error),
      };
    }
  }
}

function errorCode(error: unknown): string {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (response && typeof response === 'object') {
      const value = (response as { errorCode?: unknown }).errorCode;
      if (typeof value === 'string' && value) return value;
    }
  }
  return 'CV_MATCH_FAILED';
}
