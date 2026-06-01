import { IsEmail, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'StrongPass123!' })
  @IsString()
  password!: string;
}

export class GoogleLoginDto {
  @ApiProperty({ example: 'google-id-token' })
  @IsString()
  idToken!: string;
}
