import { PromptsService } from './prompts.service';
import { TemplateRenderer } from './template-renderer';

describe('PromptsService interview voice templates', () => {
  it('loads all realtime, TTS, and transcription prompt templates', async () => {
    const service = new PromptsService(new TemplateRenderer());

    await service.onModuleInit();

    expect(service.get('interview_realtime_voice_v1').filename).toBe(
      'interview_realtime_voice_v1.md',
    );
    expect(service.get('interview_realtime_hybrid_v1').filename).toBe(
      'interview_realtime_hybrid_v1.md',
    );
    expect(service.get('interview_tts_v1').filename).toBe('interview_tts_v1.md');
    expect(service.get('interview_transcription_vi_v1').filename).toBe(
      'interview_transcription_vi_v1.md',
    );
    expect(service.get('interview_transcription_en_v1').filename).toBe(
      'interview_transcription_en_v1.md',
    );
    expect(service.render('interview_transcription_vi_v1', {})).toContain('TypeScript');
    expect(
      service.render('interview_tts_v1', {
        interview_type: 'TECHNICAL',
        language_instruction: 'Speak Vietnamese.',
        target_role: 'frontend_developer',
      }),
    ).toContain('PostgreSQL');
  });
});
