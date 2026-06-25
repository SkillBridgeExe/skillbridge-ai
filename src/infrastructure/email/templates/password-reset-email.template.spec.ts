import { renderPasswordResetEmailTemplate } from './password-reset-email.template';

describe('renderPasswordResetEmailTemplate', () => {
  it('renders a one-time password reset CTA with the project contact email', () => {
    const resetUrl = 'https://skillbridge.app/reset-password?token=abc123';

    const result = renderPasswordResetEmailTemplate({ resetUrl });

    expect(result.subject).toBe('Reset your SkillBridge password');
    expect(result.html).toContain('Reset your password');
    expect(result.html).toContain(resetUrl);
    expect(result.html).toContain('30 minutes');
    expect(result.html).toContain('edtech.skillbridge@gmail.com');
    expect(result.html).not.toContain('margin-top: -');
    expect(result.text).toContain(resetUrl);
    expect(result.text).toContain('edtech.skillbridge@gmail.com');
  });
});
