import { CanonicalCvDocument } from '../../../common/types/canonical-cv';
import { CvReviewParsedResponse } from '../../../modules/cv-review/dto/cv-review-response.dto';

export interface CvSkillResponseDto {
  id: string | null;
  canonicalName: string | null;
  displayName: string | null;
  rawInput: string;
  matchedVia: string;
  confidence: number;
}

export interface CvResponseDto {
  id: string;
  title: string | null;
  originalFileName: string | null;
  fileType: string | null;
  fileSize: number | null;
  downloadUrl: string;
  parsedText: string | null;
  parsedJson: CanonicalCvDocument | null;
  cvKind: string;
  language: string | null;
  isOcrOnly: boolean;
  atsReadabilityScore: number | null;
  skills: CvSkillResponseDto[];
  review: CvReviewParsedResponse | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface CvListItemDto {
  id: string;
  title: string | null;
  originalFileName: string | null;
  fileType: string | null;
  fileSize: number | null;
  language: string | null;
  isOcrOnly: boolean;
  atsReadabilityScore: number | null;
  createdAt: string;
}
