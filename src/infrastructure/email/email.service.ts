import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { renderVerificationEmailTemplate } from './templates/verification-email.template';

@Injectable()
export class EmailService {
  private readonly resend: Resend;
  private readonly fromEmail: string;

  constructor(private readonly config: ConfigService) {
    const apiKey = this.config.get<string>('RESEND_API_KEY');
    this.fromEmail = this.config.get<string>('RESEND_FROM_EMAIL') ?? '';

    if (!apiKey || !this.fromEmail) {
      throw new ServiceUnavailableException({
        errorCode: 'EMAIL_SERVICE_NOT_CONFIGURED',
        message: 'Email service is not configured',
      });
    }

    this.resend = new Resend(apiKey);
  }

  async sendVerifyEmail(to: string, verifyUrl: string): Promise<void> {
    const template = renderVerificationEmailTemplate({ verifyUrl });

    const { error } = await this.resend.emails.send({
      from: this.fromEmail,
      to,
      subject: template.subject,
      html: template.html,
      text: template.text,
    });

    if (error) {
      throw new ServiceUnavailableException({
        errorCode: 'EMAIL_SEND_FAILED',
        message: 'Failed to send verification email',
      });
    }
  }
}
