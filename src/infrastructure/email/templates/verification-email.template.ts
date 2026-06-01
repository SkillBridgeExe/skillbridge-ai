import { renderEmailLayout } from './email-layout';
import { RenderedEmailTemplate } from './email-template.types';

interface VerificationEmailTemplateInput {
  verifyUrl: string;
}

export function renderVerificationEmailTemplate(
  input: VerificationEmailTemplateInput,
): RenderedEmailTemplate {
  const { verifyUrl } = input;

  return {
    subject: 'Verify your SkillBridge email',
    html: renderEmailLayout({
      eyebrow: 'Account verification',
      title: 'Activate your account',
      description:
        'Welcome to SkillBridge. Please verify your email address to activate your account and start your journey with a secure sign-in.',
      ctaLabel: 'Verify Email Address',
      ctaUrl: verifyUrl,
      fallbackLabel: 'If the button does not work, open this link in your browser:',
      fallbackUrl: verifyUrl,
      note: 'If you did not create this account, you can safely ignore this email.',
    }),
    text:
      'Welcome to SkillBridge. Please verify your email address to activate your account by visiting this link: ' +
      verifyUrl,
  };
}
