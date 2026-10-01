import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsDefined,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class ChatHistoryItemDto {
  @IsIn(['user', 'assistant'])
  role!: 'user' | 'assistant';

  @IsString()
  content!: string;
}

export class ChatContextDto {
  @Type(() => Number)
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat!: number;

  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng!: number;

  @IsString()
  locationLabel!: string;

  @IsString()
  timezone!: string;

  @IsOptional()
  @IsString()
  activeVehicleId?: string | null;

  @IsOptional()
  @IsString()
  activeStart?: string | null;

  @IsOptional()
  @IsString()
  activeEnd?: string | null;
}

export class ChatTurnDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  message!: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChatHistoryItemDto)
  history?: ChatHistoryItemDto[];

  @IsDefined()
  @ValidateNested()
  @Type(() => ChatContextDto)
  context!: ChatContextDto;
}
