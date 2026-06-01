import { IsEmail, IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class VerifyEmailDto {
  @ApiProperty({ example: 'verification-token-from-email' })
  @IsString()
  @MinLength(1)
  token!: string;
}

export class ResendVerificationEmailDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  email!: string;
}
