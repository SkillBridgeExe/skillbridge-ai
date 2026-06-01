import { renderVerificationEmailTemplate } from './verification-email.template';

describe('renderVerificationEmailTemplate', () => {
  it('renders a reusable verification email with branded hero and CTA fallback', () => {
    const verifyUrl = 'https://skillbridge.app/verify-email?token=abc123';

    const result = renderVerificationEmailTemplate({ verifyUrl });

    expect(result.subject).toBe('Verify your SkillBridge email');
    expect(result.html).toContain('Welcome to SkillBridge');
    expect(result.html).toContain('Verify Email Address');
    expect(result.html).toContain('Activate your account');
    expect(result.html).toContain(verifyUrl);
    expect(result.html).toContain('If the button does not work');
    expect(result.text).toContain('Welcome to SkillBridge.');
    expect(result.text).toContain(verifyUrl);
  });
});
