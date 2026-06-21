import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class LearningChatRequestDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  message!: string;

  @IsOptional()
  @IsUUID()
  conversationId?: string;

  @IsOptional()
  @IsUUID()
  matchId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  language?: string;
}
