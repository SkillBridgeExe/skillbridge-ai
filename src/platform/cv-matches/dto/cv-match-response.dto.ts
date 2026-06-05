import { CvJdMatchParsedResponse } from '../../../modules/cv-jd-match/dto/cv-jd-match-response.dto';

export interface JobDescriptionSummaryDto {
  id: string;
  title: string | null;
  sourceType: string | null;
  createdAt: string;
}

export interface CvMatchResponseDto {
  id: string;
  cvId: string;
  jobDescriptionId: string | null;
  aiResultId: string | null;
  overallScore: number | null;
  matchRatio: number | null;
  requiredCoverage: number | null;
  parsedResponse: CvJdMatchParsedResponse | null;
  jobDescription: JobDescriptionSummaryDto | null;
  createdAt: string;
}

export interface CvMatchListItemDto {
  id: string;
  cvId: string;
  jobDescriptionId: string | null;
  jobTitle: string | null;
  sourceType: string | null;
  overallScore: number | null;
  matchRatio: number | null;
  requiredCoverage: number | null;
  createdAt: string;
}
