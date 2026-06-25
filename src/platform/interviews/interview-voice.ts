import {
  DEFAULT_INTERVIEW_VOICE,
  INTERVIEW_VOICES,
  InterviewVoice,
} from '../../database/entities/interview-session.entity';

export function resolveInterviewVoice(
  requestedVoice: string | null | undefined,
  configuredVoice: string | null | undefined,
): InterviewVoice {
  for (const candidate of [requestedVoice, configuredVoice]) {
    if ((INTERVIEW_VOICES as readonly string[]).includes(candidate ?? '')) {
      return candidate as InterviewVoice;
    }
  }
  return DEFAULT_INTERVIEW_VOICE;
}
