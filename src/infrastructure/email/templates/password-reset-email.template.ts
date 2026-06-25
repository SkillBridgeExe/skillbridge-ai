import { renderEmailLayout, SKILLBRIDGE_SUPPORT_EMAIL } from './email-layout';
import { RenderedEmailTemplate } from './email-template.types';

interface PasswordResetEmailTemplateInput {
  resetUrl: string;
}

export function renderPasswordResetEmailTemplate(
  input: PasswordResetEmailTemplateInput,
): RenderedEmailTemplate {
  const { resetUrl } = input;

  return {
    subject: 'Reset your SkillBridge password',
    html: renderEmailLayout({
      eyebrow: 'Account security',
      title: 'Reset your password',
      description:
        'We received a request to reset your SkillBridge password. This secure link expires in 30 minutes and can be used only once.',
      ctaLabel: 'Reset Password',
      ctaUrl: resetUrl,
      fallbackLabel: 'If the button does not work, open this link in your browser:',
      fallbackUrl: resetUrl,
      note: 'If you did not request a password reset, you can safely ignore this email.',
    }),
    text:
      `Reset your SkillBridge password within 30 minutes by visiting: ${resetUrl}\n\n` +
      `If you need help, contact ${SKILLBRIDGE_SUPPORT_EMAIL}.`,
  };
}
