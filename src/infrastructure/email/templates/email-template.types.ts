export interface EmailTemplateContent {
  eyebrow?: string;
  title: string;
  description: string;
  ctaLabel?: string;
  ctaUrl?: string;
  fallbackLabel?: string;
  fallbackUrl?: string;
  note?: string;
}

export interface RenderedEmailTemplate {
  subject: string;
  html: string;
  text: string;
}
