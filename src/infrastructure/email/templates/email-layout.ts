import { emailTheme } from './email-theme';
import { EmailTemplateContent } from './email-template.types';

export const SKILLBRIDGE_SUPPORT_EMAIL = 'edtech.skillbridge@gmail.com';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderButton(label: string, url: string): string {
  return `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 auto;">
      <tr>
        <td align="center" bgcolor="${emailTheme.colors.buttonBackground}" style="border-radius: ${emailTheme.radius.button};">
          <a href="${escapeHtml(url)}" style="display: inline-block; padding: 14px 28px; font-size: 14px; font-weight: 700; line-height: 1; color: ${emailTheme.colors.buttonText}; text-decoration: none; border-radius: ${emailTheme.radius.button};">
            ${escapeHtml(label)}
          </a>
        </td>
      </tr>
    </table>
  `;
}

export function renderEmailLayout(content: EmailTemplateContent): string {
  const eyebrow = content.eyebrow
    ? `<p style="margin: 0 0 10px; color: ${emailTheme.colors.textInverse}; font-size: 12px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase;">${escapeHtml(content.eyebrow)}</p>`
    : '';
  const cta =
    content.ctaLabel && content.ctaUrl ? renderButton(content.ctaLabel, content.ctaUrl) : '';
  const fallback =
    content.fallbackLabel && content.fallbackUrl
      ? `
      <div style="margin-top: 22px; padding-top: 18px; border-top: 1px solid ${emailTheme.colors.cardBorder};">
        <p style="margin: 0 0 8px; color: ${emailTheme.colors.textMuted}; font-size: 13px; line-height: 1.6;">
          ${escapeHtml(content.fallbackLabel)}
        </p>
        <p style="margin: 0;">
          <a href="${escapeHtml(content.fallbackUrl)}" style="color: ${emailTheme.colors.link}; font-size: 13px; line-height: 1.6; word-break: break-all; text-decoration: none;">
            ${escapeHtml(content.fallbackUrl)}
          </a>
        </p>
      </div>
    `
      : '';
  const note = content.note
    ? `<p style="margin: 24px 0 0; color: ${emailTheme.colors.textMuted}; font-size: 13px; line-height: 1.7; text-align: center;">${escapeHtml(content.note)}</p>`
    : '';

  return `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>SkillBridge</title>
      </head>
      <body style="margin: 0; padding: 24px 12px; background-color: ${emailTheme.colors.pageBackground}; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="border-collapse: collapse;">
          <tr>
            <td align="center">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width: 600px; border-collapse: separate; border-spacing: 0;">
                <tr>
                  <td align="center" bgcolor="${emailTheme.colors.heroStart}" style="background: linear-gradient(135deg, ${emailTheme.colors.heroStart} 0%, ${emailTheme.colors.heroEnd} 100%); border-radius: 28px 28px 0 0; padding: 32px;">
                      <p style="margin: 0 0 12px; color: ${emailTheme.colors.textInverse}; font-size: 28px; font-weight: 800; letter-spacing: -0.02em;">
                        SkillBridge
                      </p>
                      ${eyebrow}
                      <h1 style="margin: 0; color: #ffffff; font-size: 30px; line-height: 1.2; font-weight: 800;">
                        ${escapeHtml(content.title)}
                      </h1>
                  </td>
                </tr>
                <tr>
                  <td bgcolor="${emailTheme.colors.cardBackground}" style="background-color: ${emailTheme.colors.cardBackground}; border: 1px solid ${emailTheme.colors.cardBorder}; border-top: 0; border-radius: 0 0 ${emailTheme.radius.card} ${emailTheme.radius.card}; padding: 32px;">
                      <p style="margin: 0 0 28px; color: ${emailTheme.colors.textSecondary}; font-size: 15px; line-height: 1.8;">
                        ${escapeHtml(content.description)}
                      </p>
                      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                        <tr>
                          <td align="center">
                        ${cta}
                          </td>
                        </tr>
                      </table>
                      ${fallback}
                      ${note}
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding: 18px 12px 0; color: ${emailTheme.colors.footerText}; font-size: 12px; line-height: 1.6;">
                    SkillBridge helps you move from profile setup to career-ready action.<br />
                    Support: <a href="mailto:${SKILLBRIDGE_SUPPORT_EMAIL}" style="color: ${emailTheme.colors.link}; text-decoration: none;">${SKILLBRIDGE_SUPPORT_EMAIL}</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
    </html>
  `;
}
