import { Body, Controller, Post, Req, UseFilters } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { ChatService } from './chat.service.js';
import { ChatValidationErrorFilter } from './chat-validation-error.filter.js';
import { ChatTurnDto } from './dto/chat-turn.dto.js';

type AuthedRequest = Request & { user: { id: string } };

@ApiTags('chat')
@ApiBearerAuth()
@Controller('chat')
@UseFilters(ChatValidationErrorFilter)
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post()
  turn(@Req() request: AuthedRequest, @Body() dto: ChatTurnDto) {
    return this.chatService.turn(dto, request.user.id);
  }
}
