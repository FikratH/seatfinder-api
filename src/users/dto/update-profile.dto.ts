import { IsHexColor, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * DTO for `PATCH /users/me` — every field is optional and we treat
 * an explicit `null` as "clear this field".
 */
export class UpdateProfileDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 40 })
  @IsOptional()
  @IsString()
  @Length(1, 40)
  displayName?: string | null;

  @ApiPropertyOptional({ description: 'Hex color, e.g. #0EA5E9' })
  @IsOptional()
  @IsHexColor()
  avatarColor?: string | null;

  @ApiPropertyOptional({ maxLength: 280 })
  @IsOptional()
  @IsString()
  @MaxLength(280)
  bio?: string | null;
}
