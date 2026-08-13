import { Injectable } from '@nestjs/common';

export type InterviewExperienceMode = 'MOCK' | 'PRACTICE';
export type CandidateIntent =
  | 'ANSWER'
  | 'NO_ANSWER'
  | 'REPEAT'
  | 'CLARIFY'
  | 'EASIER'
  | 'HINT'
  | 'FEEDBACK'
  | 'SKIP'
  | 'END';
export type RealtimeAnswerSignal = 'COMPLETE' | 'PARTIAL' | 'OFF_TOPIC' | 'NO_ANSWER';
export type InterviewDirectiveAction =
  | 'FOLLOW_UP'
  | 'ADVANCE_TOPIC'
  | 'LOWER_DIFFICULTY'
  | 'GIVE_HINT'
  | 'GIVE_FEEDBACK'
  | 'DECLINE_COACHING'
  | 'REPEAT'
  | 'CLARIFY'
  | 'WRAP_UP'
  | 'RETRY_CAPTURE';
export type InterviewAssistanceLevel = 'NONE' | 'EASIER' | 'HINT' | 'SKIPPED';

export interface RealtimeTurnPolicyState {
  topicId: string;
  questionThreadId: string;
  difficultyStep: number;
  noAnswerCount: number;
  probeCount: number;
  assistanceLevel: InterviewAssistanceLevel;
  scoreCap: number | null;
}

export interface RealtimeTurnPolicyInput {
  experienceMode: InterviewExperienceMode;
  intent: CandidateIntent;
  answerSignal: RealtimeAnswerSignal;
  state: RealtimeTurnPolicyState;
  nextTopicId: string | null;
  captureInvalid?: boolean;
  nextQuestionThreadId: string | null;
}

export interface InterviewTurnPolicyResult {
  action: InterviewDirectiveAction;
  consumesAttempt: boolean;
  finished: boolean;
  assistanceLevel: InterviewAssistanceLevel;
  scoreCap: number | null;
  threadScore: number | null;
  state: RealtimeTurnPolicyState;
  reasons: string[];
}

@Injectable()
export class InterviewTurnPolicyService {
  decide(input: RealtimeTurnPolicyInput): InterviewTurnPolicyResult {
    const { intent, state } = input;

    if (intent === 'END') {
      return this.result('WRAP_UP', false, true, state, ['user_requested_end']);
    }
    if (intent === 'REPEAT') {
      return this.result('REPEAT', false, false, state, ['repeat_requested']);
    }
    if (intent === 'CLARIFY') {
      return this.result('CLARIFY', false, false, state, ['clarification_requested']);
    }
    if (input.captureInvalid) {
      return this.result('RETRY_CAPTURE', false, false, state, ['invalid_audio_capture']);
    }
    if (intent === 'FEEDBACK') {
      const action = input.experienceMode === 'PRACTICE' ? 'GIVE_FEEDBACK' : 'DECLINE_COACHING';
      return this.result(action, false, false, state, [
        input.experienceMode === 'PRACTICE'
          ? 'practice_feedback_requested'
          : 'mock_coaching_unavailable',
      ]);
    }
    if (intent === 'EASIER') {
      return this.lowerDifficulty(state, false, ['easier_question_requested']);
    }
    if (intent === 'HINT') {
      if (input.experienceMode === 'MOCK') {
        return this.lowerDifficulty(state, false, ['mock_hint_converted_to_easier']);
      }
      const hintedState = this.withAssistance(state, 'HINT', 60);
      return this.result('GIVE_HINT', false, false, hintedState, ['practice_hint_requested']);
    }
    if (intent === 'SKIP') {
      return this.advance(input, true, 0, 'SKIPPED', 0, ['question_skipped']);
    }

    const answerSignal = intent === 'NO_ANSWER' ? 'NO_ANSWER' : input.answerSignal;
    if (answerSignal === 'NO_ANSWER') {
      if (state.noAnswerCount === 0) {
        const easier = this.withAssistance(
          {
            ...state,
            difficultyStep: Math.max(-2, state.difficultyStep - 1),
            noAnswerCount: 1,
          },
          'EASIER',
          75,
        );
        return this.result('LOWER_DIFFICULTY', true, false, easier, [
          'first_no_answer',
          'lower_difficulty_once',
        ]);
      }
      return this.advance(input, true, 0, state.assistanceLevel, state.scoreCap, [
        'second_no_answer',
        'move_on_fairly',
      ]);
    }

    if (answerSignal === 'PARTIAL' && state.probeCount === 0) {
      const probedState = { ...state, probeCount: 1 };
      return this.result('FOLLOW_UP', true, false, probedState, [
        'partial_answer',
        'one_contextual_probe',
      ]);
    }

    if (answerSignal === 'OFF_TOPIC' && state.probeCount === 0) {
      const clarifiedState = { ...state, probeCount: 1 };
      return this.result('CLARIFY', true, false, clarifiedState, [
        'off_topic_answer',
        'clarify_once',
      ]);
    }

    return this.advance(input, true, null, state.assistanceLevel, state.scoreCap, [
      answerSignal === 'COMPLETE' ? 'answer_complete' : 'probe_limit_reached',
    ]);
  }

  private lowerDifficulty(
    state: RealtimeTurnPolicyState,
    consumesAttempt: boolean,
    reasons: string[],
  ): InterviewTurnPolicyResult {
    const easierState = this.withAssistance(
      { ...state, difficultyStep: Math.max(-2, state.difficultyStep - 1) },
      'EASIER',
      75,
    );
    return this.result('LOWER_DIFFICULTY', consumesAttempt, false, easierState, reasons);
  }

  private advance(
    input: RealtimeTurnPolicyInput,
    consumesAttempt: boolean,
    threadScore: number | null,
    assistanceLevel: InterviewAssistanceLevel,
    scoreCap: number | null,
    reasons: string[],
  ): InterviewTurnPolicyResult {
    if (!input.nextTopicId || !input.nextQuestionThreadId) {
      return {
        ...this.result('WRAP_UP', consumesAttempt, true, input.state, [
          ...reasons,
          'agenda_complete',
        ]),
        assistanceLevel,
        scoreCap,
        threadScore,
      };
    }

    const nextState: RealtimeTurnPolicyState = {
      topicId: input.nextTopicId,
      questionThreadId: input.nextQuestionThreadId,
      difficultyStep: 0,
      noAnswerCount: 0,
      probeCount: 0,
      assistanceLevel: 'NONE',
      scoreCap: null,
    };
    return {
      ...this.result('ADVANCE_TOPIC', consumesAttempt, false, nextState, reasons),
      assistanceLevel,
      scoreCap,
      threadScore,
    };
  }

  private withAssistance(
    state: RealtimeTurnPolicyState,
    assistanceLevel: InterviewAssistanceLevel,
    scoreCap: number,
  ): RealtimeTurnPolicyState {
    const nextCap = state.scoreCap === null ? scoreCap : Math.min(state.scoreCap, scoreCap);
    const nextAssistance =
      nextCap === 60 ? 'HINT' : assistanceLevel === 'SKIPPED' ? 'SKIPPED' : 'EASIER';
    return { ...state, assistanceLevel: nextAssistance, scoreCap: nextCap };
  }

  private result(
    action: InterviewDirectiveAction,
    consumesAttempt: boolean,
    finished: boolean,
    state: RealtimeTurnPolicyState,
    reasons: string[],
  ): InterviewTurnPolicyResult {
    return {
      action,
      consumesAttempt,
      finished,
      assistanceLevel: state.assistanceLevel,
      scoreCap: state.scoreCap,
      threadScore: null,
      state,
      reasons,
    };
  }
}
