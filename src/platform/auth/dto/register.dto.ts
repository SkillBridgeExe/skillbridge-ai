import { IsEmail, IsEnum, IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export enum PublicRegisterRole {
  USER = 'USER',
  BUSINESS = 'BUSINESS',
  MENTOR = 'MENTOR',
}

export class RegisterDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'StrongPass123!' })
  @IsString()
  @MinLength(8)
  password!: string;

  @ApiProperty({ example: 'Nguyen Van A' })
  @IsString()
  @MinLength(1)
  displayName!: string;

  @ApiProperty({
    enum: PublicRegisterRole,
    example: PublicRegisterRole.USER,
    description: 'Role selected during self-registration. ADMIN is not allowed here.',
  })
  @IsEnum(PublicRegisterRole)
  role!: PublicRegisterRole;
}
