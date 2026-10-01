import {
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ReservationOverlapException,
  ReservationsService,
  VehicleUnavailableException,
  type ReservationView,
} from '../reservations/reservations.service.js';
import { SearchVehiclesQuery } from '../vehicles/dto/search-vehicles.query.js';
import { VehicleDateRangeDto } from '../vehicles/dto/vehicle-date-range.js';
import {
  VehicleNotFoundException,
  VehiclesService,
  type VehicleSearchResult,
} from '../vehicles/vehicles.service.js';
import type { ChatContextDto, ChatTurnDto } from './dto/chat-turn.dto.js';

const CHAT_BUDGET_MS = 20_000;

const SEARCH_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_vehicles',
      description:
        'Search rental vehicles near the renter pin. Nest supplies latitude and longitude from the turn context. Dates must be ISO-8601 instants.',
      parameters: {
        type: 'object',
        properties: {
          lat: { type: 'number' },
          lng: { type: 'number' },
          radiusKm: {
            type: 'number',
            description: 'Kilometres. Default 10. Maximum 50.',
          },
          type: {
            type: 'string',
            enum: ['suv', 'sedan', 'hatchback', 'muv'],
          },
          transmission: {
            type: 'string',
            enum: ['automatic', 'manual'],
          },
          maxPricePerDay: {
            type: 'number',
            description: 'Inclusive maximum INR per day.',
          },
          startDate: { type: 'string' },
          endDate: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_vehicle_details',
      description:
        'Read one vehicle. A missing vehicleId uses the active vehicle. Distance is computed from the turn coordinates.',
      parameters: {
        type: 'object',
        properties: {
          vehicleId: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_availability',
      description:
        'Report whether a vehicle is free between two ISO-8601 instants. A missing vehicleId uses the active vehicle. Missing dates use the active range, or tomorrow.',
      parameters: {
        type: 'object',
        properties: {
          vehicleId: { type: 'string' },
          startDate: { type: 'string' },
          endDate: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculate_rental_price',
      description:
        'Return dayCount, pricePerDay, totalPrice, securityDeposit, and currency INR. securityDeposit is not included in totalPrice. A missing vehicleId uses the active vehicle. Missing dates use the active range, or tomorrow.',
      parameters: {
        type: 'object',
        properties: {
          vehicleId: { type: 'string' },
          startDate: { type: 'string' },
          endDate: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_reservation',
      description:
        'Reserve a vehicle for the signed-in user. A missing vehicleId uses the active vehicle. Missing dates use the active range, or tomorrow. Do not send a user id.',
      parameters: {
        type: 'object',
        properties: {
          vehicleId: { type: 'string' },
          startDate: { type: 'string' },
          endDate: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_rental_policy',
      description:
        'Answer a question from the rental guide. Pass only the question as query.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
      },
    },
  },
];

const KNOWN_TOOLS = new Set([
  'search_vehicles',
  'get_vehicle_details',
  'check_availability',
  'calculate_rental_price',
  'create_reservation',
  'search_rental_policy',
]);

export const GUIDE_DOES_NOT_COVER = 'The guide does not cover that question.';

export type PolicyCitation = {
  document: string;
  chunkId: string;
  score: number;
};

export const VEHICLE_ALREADY_BOOKED =
  'The vehicle is already booked for those dates.';

export type ChatVehicle = VehicleSearchResult & {
  rankScore: number;
  reason: string;
};

export type ToolTraceEntry = {
  name: string;
  arguments: Record<string, unknown>;
  ok: boolean;
};

export type ChatTurnResult = {
  reply: string;
  citations: PolicyCitation[];
  vehicles: ChatVehicle[];
  reservation: ReservationView | null;
  toolTrace: ToolTraceEntry[];
};

type ToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

type LlmMessage = {
  role: string;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

type ToolOutcome = {
  name: string;
  arguments: Record<string, unknown>;
  ok: boolean;
  vehicles: ChatVehicle[];
  modelPayload: Record<string, unknown>;
  reservation?: ReservationView | null;
  userMessage?: string;
  policy?:
    | { grounded: true; answer: string; citations: PolicyCitation[] }
    | { grounded: false };
};

export class LlmUnavailableException extends HttpException {
  constructor() {
    super(
      {
        statusCode: 503,
        code: 'LLM_UNAVAILABLE',
        message: 'The assistant is unavailable right now.',
      },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}

class LlmKeyRejectedException extends Error {}

const unconfiguredReservations = {
  create: async () => {
    throw new Error('ReservationsService is not configured');
  },
} as unknown as ReservationsService;

@Injectable()
export class ChatService {
  constructor(
    private readonly vehicles: VehiclesService,
    private readonly config: ConfigService,
    private readonly reservations: ReservationsService = unconfiguredReservations,
  ) {}

  async turn(dto: ChatTurnDto, userId: string): Promise<ChatTurnResult> {
    const apiKey = this.config.get<string>('LLM_API_KEY')?.trim();
    const baseUrl = this.config.get<string>('LLM_BASE_URL')?.trim();
    if (!apiKey || !baseUrl) {
      return this.ruleTurn(dto, userId);
    }
    try {
      return await this.modelTurn(dto, userId);
    } catch (error) {
      if (error instanceof LlmKeyRejectedException) {
        return this.ruleTurn(dto, userId);
      }
      throw error;
    }
  }

  private async modelTurn(dto: ChatTurnDto, userId: string): Promise<ChatTurnResult> {
    const deadline = Date.now() + CHAT_BUDGET_MS;
    const messages: LlmMessage[] = [
      { role: 'system', content: systemPrompt(dto.context) },
      ...(dto.history ?? []).map((item) => ({
        role: item.role,
        content: item.content,
      })),
      { role: 'user', content: dto.message },
    ];

    let vehicles: ChatVehicle[] = [];
    let reservation: ReservationView | null = null;
    let reservationNotice: string | null = null;
    let policyReply: string | null = null;
    let citations: PolicyCitation[] = [];
    const toolTrace: ToolTraceEntry[] = [];
    let usedTools = false;
    const finish = (reply: string): ChatTurnResult => ({
      reply: reservationNotice ?? policyReply ?? reply,
      citations,
      vehicles,
      reservation,
      toolTrace,
    });

    for (let round = 0; round < 5; round += 1) {
      let message: LlmMessage;
      try {
        message = await this.complete(messages, true, deadline);
      } catch (error) {
        if (error instanceof LlmKeyRejectedException && usedTools) {
          throw new LlmUnavailableException();
        }
        throw error;
      }
      const toolCalls = message.tool_calls ?? [];
      if (toolCalls.length === 0) {
        return finish(message.content ?? '');
      }

      messages.push({
        role: 'assistant',
        content: message.content,
        tool_calls: toolCalls,
      });

      usedTools = true;
      for (const call of toolCalls) {
        const outcome = await this.executeTool(call, dto.context, deadline, userId);
        toolTrace.push({
          name: outcome.name,
          arguments: outcome.arguments,
          ok: outcome.ok,
        });
        if (outcome.name === 'search_vehicles') {
          vehicles = outcome.ok ? outcome.vehicles : [];
        }
        if (outcome.name === 'create_reservation') {
          if (outcome.ok && outcome.reservation) {
            reservation = outcome.reservation;
            reservationNotice = null;
          } else if (reservation === null) {
            reservation = null;
            reservationNotice =
              outcome.userMessage ?? 'That reservation could not be completed.';
          }
        }
        if (outcome.policy) {
          if (outcome.policy.grounded) {
            policyReply = outcome.policy.answer;
            citations = outcome.policy.citations;
          } else {
            policyReply = GUIDE_DOES_NOT_COVER;
            citations = [];
          }
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(outcome.modelPayload),
        });
      }
      if (policyReply !== null) {
        return finish(policyReply);
      }
    }

    let finalMessage: LlmMessage;
    try {
      finalMessage = await this.complete(messages, false, deadline);
    } catch (error) {
      if (error instanceof LlmKeyRejectedException && usedTools) {
        throw new LlmUnavailableException();
      }
      throw error;
    }
    return finish(finalMessage.content ?? '');
  }

  private async complete(
    messages: LlmMessage[],
    withTools: boolean,
    deadline: number,
  ): Promise<LlmMessage> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new LlmUnavailableException();
    }

    const baseUrl = this.config.get<string>('LLM_BASE_URL');
    const apiKey = this.config.get<string>('LLM_API_KEY');
    const model = this.config.get<string>('LLM_MODEL') || 'gpt-4o-mini';
    if (!baseUrl || !apiKey) {
      throw new LlmUnavailableException();
    }

    const body: Record<string, unknown> = {
      model,
      temperature: 0.2,
      messages,
    };
    if (withTools) {
      body.tools = SEARCH_TOOLS;
      body.tool_choice = 'auto';
    }

    let response: Response;
    try {
      response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(remaining),
      });
    } catch {
      throw new LlmUnavailableException();
    }

    if (response.status === 401 || response.status === 403) {
      throw new LlmKeyRejectedException();
    }
    if (!response.ok) {
      throw new LlmUnavailableException();
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new LlmUnavailableException();
    }

    const message = readAssistantMessage(payload);
    if (!message) {
      throw new LlmUnavailableException();
    }
    return message;
  }

  private async executeTool(
    call: ToolCall,
    context: ChatContextDto,
    deadline: number,
    userId: string,
  ): Promise<ToolOutcome> {
    const name = call.function?.name ?? 'unknown';
    const parsed = parseArguments(call.function?.arguments);
    if (!parsed || !KNOWN_TOOLS.has(name)) {
      return {
        name,
        arguments: parsed ?? {},
        ok: false,
        vehicles: [],
        modelPayload: { ok: false, error: 'That tool is not available.' },
      };
    }
    if (name === 'get_vehicle_details') {
      return this.executeDetails(parsed, context);
    }
    if (name === 'check_availability') {
      return this.executeAvailability(parsed, context);
    }
    if (name === 'calculate_rental_price') {
      return this.executePrice(parsed, context);
    }
    if (name === 'create_reservation') {
      return this.executeReservation(parsed, context, userId);
    }
    if (name === 'search_rental_policy') {
      return this.executePolicy(parsed, deadline);
    }

    const normalized = normalizeSearchArguments(parsed, context);
    if (!normalized.ok) {
      return {
        name,
        arguments: normalized.arguments,
        ok: false,
        vehicles: [],
        modelPayload: { ok: false, error: 'Search filters are not valid.' },
      };
    }

    const errors = await validate(normalized.query);
    if (errors.length > 0) {
      return {
        name,
        arguments: normalized.arguments,
        ok: false,
        vehicles: [],
        modelPayload: { ok: false, error: 'Search filters are not valid.' },
      };
    }

    let rows: VehicleSearchResult[];
    try {
      rows = await this.vehicles.search(normalized.query);
    } catch {
      return {
        name,
        arguments: normalized.arguments,
        ok: false,
        vehicles: [],
        modelPayload: { ok: false, error: 'Search failed.' },
      };
    }

    if (rows.length === 0) {
      return {
        name,
        arguments: normalized.arguments,
        ok: true,
        vehicles: [],
        modelPayload: {
          ok: true,
          vehicles: [],
          filters: normalized.filters,
        },
      };
    }

    const ranked = await this.rankCandidates(
      rows,
      normalized.filters,
      deadline,
    );
    if (!ranked.ok) {
      return {
        name,
        arguments: normalized.arguments,
        ok: false,
        vehicles: [],
        modelPayload: { ok: false, error: 'Ranking failed.' },
      };
    }

    return {
      name,
      arguments: normalized.arguments,
      ok: true,
      vehicles: ranked.vehicles,
      modelPayload: {
        ok: true,
        vehicles: ranked.vehicles,
        filters: normalized.filters,
      },
    };
  }

  private async rankCandidates(
    rows: VehicleSearchResult[],
    filters: Record<string, unknown>,
    deadline: number,
  ): Promise<{ ok: true; vehicles: ChatVehicle[] } | { ok: false }> {
    const remaining = deadline - Date.now();
    const baseUrl = this.config.get<string>('AI_SERVICE_URL');
    const token = this.config.get<string>('AI_SERVICE_TOKEN');
    if (remaining <= 0 || !baseUrl || !token) {
      return { ok: false };
    }

    const radiusKm = filters.radiusKm;
    const payload: Record<string, unknown> = {
      radiusKm,
      vehicles: rows.map((row) => ({
        id: row.id,
        distanceKm: row.distanceKm,
        pricePerDay: row.pricePerDay,
        type: row.type,
        transmission: row.transmission,
      })),
    };
    if (filters.type !== undefined) {
      payload.type = filters.type;
    }
    if (filters.transmission !== undefined) {
      payload.transmission = filters.transmission;
    }
    if (filters.maxPricePerDay !== undefined) {
      payload.maxPricePerDay = filters.maxPricePerDay;
    }

    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/rank`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Token': token,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(Math.min(remaining, 8_000)),
      });
      if (!response.ok) {
        return { ok: false };
      }
      const body: unknown = await response.json();
      return joinRanked(rows, body);
    } catch {
      return { ok: false };
    }
  }

  private async executePolicy(
    raw: Record<string, unknown>,
    deadline: number,
  ): Promise<ToolOutcome> {
    const query = raw.query;
    if (typeof query !== 'string' || query.trim() === '') {
      return policyFailure({});
    }
    const argumentsForTrace = { query };
    const remaining = deadline - Date.now();
    const baseUrl = this.config.get<string>('AI_SERVICE_URL');
    const token = this.config.get<string>('AI_SERVICE_TOKEN');
    if (remaining <= 0 || !baseUrl || !token) {
      return policyFailure(argumentsForTrace);
    }

    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/rag/query`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Token': token,
        },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(Math.min(remaining, 8_000)),
      });
      if (!response.ok) {
        return policyFailure(argumentsForTrace);
      }
      const decision = readPolicy(await response.json());
      if (!decision) {
        return policyFailure(argumentsForTrace);
      }
      if (!decision.grounded) {
        return {
          name: 'search_rental_policy',
          arguments: argumentsForTrace,
          ok: true,
          vehicles: [],
          modelPayload: { ok: true, grounded: false },
          policy: { grounded: false },
        };
      }
      return {
        name: 'search_rental_policy',
        arguments: argumentsForTrace,
        ok: true,
        vehicles: [],
        modelPayload: { ok: true, grounded: true },
        policy: {
          grounded: true,
          answer: decision.answer,
          citations: decision.citations,
        },
      };
    } catch {
      return policyFailure(argumentsForTrace);
    }
  }

  private async executeDetails(
    raw: Record<string, unknown>,
    context: ChatContextDto,
  ): Promise<ToolOutcome> {
    const resolved = resolveVehicleId(raw, context);
    if (!resolved.ok) {
      return toolFailure('get_vehicle_details', resolved.arguments);
    }
    try {
      const vehicle = await this.vehicles.details(resolved.vehicleId, {
        lat: context.lat,
        lng: context.lng,
      });
      return {
        name: 'get_vehicle_details',
        arguments: { vehicleId: resolved.vehicleId },
        ok: true,
        vehicles: [],
        modelPayload: { ok: true, vehicle },
      };
    } catch (error) {
      return this.vehicleToolError('get_vehicle_details', resolved.vehicleId, error);
    }
  }

  private async executeAvailability(
    raw: Record<string, unknown>,
    context: ChatContextDto,
  ): Promise<ToolOutcome> {
    const resolved = resolveVehicleId(raw, context);
    if (!resolved.ok) {
      return toolFailure('check_availability', resolved.arguments);
    }
    const dates = await resolveToolDates(raw, context);
    if (!dates.ok) {
      return toolFailure(
        'check_availability',
        {
          vehicleId: resolved.vehicleId,
          ...dates.arguments,
        },
        'Dates are not valid.',
      );
    }
    try {
      const result = await this.vehicles.availability(
        resolved.vehicleId,
        dates.startDate,
        dates.endDate,
      );
      return {
        name: 'check_availability',
        arguments: {
          vehicleId: resolved.vehicleId,
          startDate: dates.startDate,
          endDate: dates.endDate,
        },
        ok: true,
        vehicles: [],
        modelPayload: { ok: true, ...result },
      };
    } catch (error) {
      return this.vehicleToolError('check_availability', resolved.vehicleId, error, {
        startDate: dates.startDate,
        endDate: dates.endDate,
      });
    }
  }

  private async executePrice(
    raw: Record<string, unknown>,
    context: ChatContextDto,
  ): Promise<ToolOutcome> {
    const resolved = resolveVehicleId(raw, context);
    if (!resolved.ok) {
      return toolFailure('calculate_rental_price', resolved.arguments);
    }
    const dates = await resolveToolDates(raw, context);
    if (!dates.ok) {
      return toolFailure(
        'calculate_rental_price',
        {
          vehicleId: resolved.vehicleId,
          ...dates.arguments,
        },
        'Dates are not valid.',
      );
    }
    try {
      const price = await this.vehicles.price(
        resolved.vehicleId,
        dates.startDate,
        dates.endDate,
      );
      return {
        name: 'calculate_rental_price',
        arguments: {
          vehicleId: resolved.vehicleId,
          startDate: dates.startDate,
          endDate: dates.endDate,
        },
        ok: true,
        vehicles: [],
        modelPayload: { ok: true, ...price },
      };
    } catch (error) {
      return this.vehicleToolError(
        'calculate_rental_price',
        resolved.vehicleId,
        error,
        {
          startDate: dates.startDate,
          endDate: dates.endDate,
        },
      );
    }
  }

  private async executeReservation(
    raw: Record<string, unknown>,
    context: ChatContextDto,
    userId: string,
  ): Promise<ToolOutcome> {
    const resolved = resolveVehicleId(raw, context);
    if (!resolved.ok) {
      return reservationFailure(resolved.arguments, 'That vehicle was not found.');
    }
    const dates = await resolveToolDates(raw, context);
    if (!dates.ok) {
      return reservationFailure(
        { vehicleId: resolved.vehicleId, ...dates.arguments },
        'Those dates are not valid.',
      );
    }
    const args = {
      vehicleId: resolved.vehicleId,
      startDate: dates.startDate,
      endDate: dates.endDate,
    };
    try {
      const reservation = await this.reservations.create(userId, {
        vehicleId: resolved.vehicleId,
        startDate: dates.startDate,
        endDate: dates.endDate,
      });
      return {
        name: 'create_reservation',
        arguments: args,
        ok: true,
        vehicles: [],
        reservation,
        modelPayload: { ok: true, reservation },
      };
    } catch (error) {
      return reservationFailure(args, reservationFailureCopy(error));
    }
  }

  private async ruleTurn(dto: ChatTurnDto, userId: string): Promise<ChatTurnResult> {
    const deadline = Date.now() + CHAT_BUDGET_MS;
    const steps = planRuleSteps(dto.message, dto.context);
    let vehicles: ChatVehicle[] = [];
    let reservation: ReservationView | null = null;
    let reservationNotice: string | null = null;
    let policyReply: string | null = null;
    let citations: PolicyCitation[] = [];
    const toolTrace: ToolTraceEntry[] = [];
    let reply =
      'I can search for a vehicle near you, describe the closest one, check whether it is free, price it, reserve it, or answer from the rental guide.';

    for (const step of steps) {
      let args = step.arguments;
      if (
        step.name === 'get_vehicle_details' &&
        typeof args.vehicleId !== 'string' &&
        vehicles.length === 0 &&
        toolTrace.some((entry) => entry.name === 'search_vehicles')
      ) {
        continue;
      }
      if (
        step.name === 'get_vehicle_details' &&
        typeof args.vehicleId !== 'string' &&
        vehicles.length > 0
      ) {
        const closest = [...vehicles].sort((left, right) => {
          if (left.distanceKm !== right.distanceKm) {
            return left.distanceKm - right.distanceKm;
          }
          return left.id.localeCompare(right.id);
        })[0];
        args = { vehicleId: closest.id };
      }
      const outcome = await this.executeTool(
        {
          id: `rule_${toolTrace.length + 1}`,
          type: 'function',
          function: {
            name: step.name,
            arguments: JSON.stringify(args),
          },
        },
        dto.context,
        deadline,
        userId,
      );
      toolTrace.push({
        name: outcome.name,
        arguments: outcome.arguments,
        ok: outcome.ok,
      });
      if (outcome.name === 'search_vehicles') {
        vehicles = outcome.ok ? outcome.vehicles : [];
      }
      if (outcome.name === 'create_reservation') {
        if (outcome.ok && outcome.reservation) {
          reservation = outcome.reservation;
          reservationNotice = null;
        } else if (reservation === null) {
          reservation = null;
          reservationNotice =
            outcome.userMessage ?? 'That reservation could not be completed.';
        }
      }
      if (outcome.policy) {
        if (outcome.policy.grounded) {
          policyReply = outcome.policy.answer;
          citations = outcome.policy.citations;
        } else {
          policyReply = GUIDE_DOES_NOT_COVER;
          citations = [];
        }
      }
      reply = describeRuleOutcome(outcome);
    }

    return {
      reply: reservationNotice ?? policyReply ?? reply,
      citations,
      vehicles,
      reservation,
      toolTrace,
    };
  }

  private vehicleToolError(
    name: string,
    vehicleId: string,
    error: unknown,
    extra: Record<string, unknown> = {},
  ): ToolOutcome {
    if (error instanceof VehicleNotFoundException) {
      return toolFailure(name, { vehicleId, ...extra });
    }
    return {
      name,
      arguments: { vehicleId, ...extra },
      ok: false,
      vehicles: [],
      modelPayload: { ok: false, error: 'That request could not be completed.' },
    };
  }
}

function reservationFailure(
  args: Record<string, unknown>,
  userMessage: string,
): ToolOutcome {
  return {
    ...toolFailure('create_reservation', args),
    reservation: null,
    userMessage,
  };
}

function reservationFailureCopy(error: unknown): string {
  if (error instanceof ReservationOverlapException) {
    return VEHICLE_ALREADY_BOOKED;
  }
  if (error instanceof VehicleUnavailableException) {
    return 'This vehicle cannot be reserved.';
  }
  if (error instanceof VehicleNotFoundException) {
    return 'That vehicle was not found.';
  }
  return 'That reservation could not be completed.';
}

function toolFailure(
  name: string,
  args: Record<string, unknown>,
  error?: string,
): ToolOutcome {
  return {
    name,
    arguments: args,
    ok: false,
    vehicles: [],
    modelPayload: error ? { ok: false, error } : { ok: false },
  };
}

function policyFailure(args: Record<string, unknown>): ToolOutcome {
  return {
    name: 'search_rental_policy',
    arguments: args,
    ok: false,
    vehicles: [],
    modelPayload: { ok: false },
  };
}

function readPolicy(
  body: unknown,
):
  | { grounded: false }
  | { grounded: true; answer: string; citations: PolicyCitation[] }
  | null {
  if (!body || typeof body !== 'object') {
    return null;
  }
  const record = body as { grounded?: unknown; answer?: unknown; citations?: unknown };
  if (record.grounded === false) {
    return { grounded: false };
  }
  if (record.grounded !== true || typeof record.answer !== 'string' || !Array.isArray(record.citations)) {
    return null;
  }
  const citations: PolicyCitation[] = [];
  for (const item of record.citations.slice(0, 3)) {
    if (!item || typeof item !== 'object') {
      return null;
    }
    const row = item as { document?: unknown; chunkId?: unknown; score?: unknown };
    if (
      typeof row.document !== 'string' ||
      typeof row.chunkId !== 'string' ||
      typeof row.score !== 'number'
    ) {
      return null;
    }
    citations.push({
      document: row.document,
      chunkId: row.chunkId,
      score: row.score,
    });
  }
  return { grounded: true, answer: record.answer, citations };
}

function resolveVehicleId(
  raw: Record<string, unknown>,
  context: ChatContextDto,
):
  | { ok: true; vehicleId: string }
  | { ok: false; arguments: Record<string, unknown> } {
  const supplied = raw.vehicleId;
  if (typeof supplied === 'string' && supplied.trim() !== '') {
    return { ok: true, vehicleId: supplied.trim() };
  }
  if (supplied !== undefined && supplied !== null && supplied !== '') {
    return { ok: false, arguments: { vehicleId: supplied } };
  }
  if (
    typeof context.activeVehicleId === 'string' &&
    context.activeVehicleId.trim() !== ''
  ) {
    return { ok: true, vehicleId: context.activeVehicleId };
  }
  return { ok: false, arguments: {} };
}

/** 10:00 Asia/Kolkata tomorrow through 10:00 the next day (04:30Z, 24 hours). */
export function tomorrowWindow(now = new Date(Date.now())): {
  startDate: string;
  endDate: string;
} {
  const wall = new Date(now.getTime() + (5 * 60 + 30) * 60 * 1000);
  const startMs = Date.UTC(
    wall.getUTCFullYear(),
    wall.getUTCMonth(),
    wall.getUTCDate() + 1,
    4,
    30,
    0,
    0,
  );
  return {
    startDate: new Date(startMs).toISOString(),
    endDate: new Date(startMs + 24 * 60 * 60 * 1000).toISOString(),
  };
}

async function resolveToolDates(
  raw: Record<string, unknown>,
  context: ChatContextDto,
): Promise<
  | { ok: true; startDate: string; endDate: string }
  | { ok: false; arguments: Record<string, unknown> }
> {
  const startMissing = raw.startDate === undefined || raw.startDate === null;
  const endMissing = raw.endDate === undefined || raw.endDate === null;
  let startDate: string;
  let endDate: string;
  if (!startMissing || !endMissing) {
    if (typeof raw.startDate !== 'string' || typeof raw.endDate !== 'string') {
      return {
        ok: false,
        arguments: { startDate: raw.startDate, endDate: raw.endDate },
      };
    }
    startDate = raw.startDate;
    endDate = raw.endDate;
  } else if (
    typeof context.activeStart === 'string' &&
    context.activeStart !== '' &&
    typeof context.activeEnd === 'string' &&
    context.activeEnd !== ''
  ) {
    startDate = context.activeStart;
    endDate = context.activeEnd;
  } else {
    const window = tomorrowWindow();
    startDate = window.startDate;
    endDate = window.endDate;
  }

  const query = plainToInstance(VehicleDateRangeDto, { startDate, endDate });
  const errors = await validate(query);
  if (errors.length > 0) {
    return { ok: false, arguments: { startDate, endDate } };
  }
  return { ok: true, startDate, endDate };
}

function systemPrompt(context: ChatContextDto): string {
  const activeVehicle = context.activeVehicleId
    ? `The active vehicle id is ${context.activeVehicleId}.`
    : 'There is no active vehicle yet.';
  const activeRange =
    context.activeStart && context.activeEnd
      ? `The active range is ${context.activeStart} to ${context.activeEnd}.`
      : 'There is no active date range yet.';

  return [
    'You are DRN, the DiscoverRideNear rental assistant.',
    'Call search_vehicles to find vehicles. Call get_vehicle_details, check_availability, calculate_rental_price, and create_reservation for one vehicle. Never invent a vehicle, a price, or a booking.',
    'Call search_rental_policy with query set to the renter question for cancellation, late return, insurance, the security deposit, or fuel. Do not answer those questions from general knowledge.',
    'An id written in the user message must be passed as vehicleId. Omit vehicleId only when the message does not name one, so the active vehicle is used.',
    'Omit dates only for check_availability, calculate_rental_price, and create_reservation. Missing dates on those tools use the active range, or tomorrow when no range is stored.',
    'A start and end written in the user message must be passed as startDate and endDate.',
    'Never pass a user id. create_reservation books the signed-in user.',
    'If create_reservation returns ok false because the vehicle is already booked, tell the user: The vehicle is already booked for those dates.',
    'Copy dayCount, pricePerDay, totalPrice, securityDeposit, and currency from calculate_rental_price. Do not add the deposit into the total.',
    `The renter pin is latitude ${context.lat}, longitude ${context.lng} (${context.locationLabel}). Timezone is Asia/Kolkata.`,
    '"Tomorrow" is 10:00 Asia/Kolkata to 10:00 the next day. Send startDate and endDate as ISO-8601 instants.',
    'Near me means the pin above. Do not choose different coordinates.',
    activeVehicle,
    'A location question calls get_vehicle_details for the active vehicle.',
    activeRange,
    'If the tool returns vehicles as an empty list, name the applied filters in the reply and do not invent a vehicle.',
    'If a tool returns ok false, tell the user in plain language and do not invent a vehicle or price.',
    'Do not mention internal services, tokens, or configuration.',
  ].join('\n');
}

function readAssistantMessage(payload: unknown): LlmMessage | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }
  const message = (choices[0] as { message?: unknown }).message;
  if (!message || typeof message !== 'object') {
    return null;
  }
  const record = message as {
    content?: unknown;
    tool_calls?: unknown;
  };
  const content = typeof record.content === 'string' ? record.content : null;
  const toolCalls = Array.isArray(record.tool_calls)
    ? record.tool_calls.filter(isToolCall)
    : undefined;
  return {
    role: 'assistant',
    content,
    tool_calls: toolCalls,
  };
}

function isToolCall(value: unknown): value is ToolCall {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const call = value as ToolCall;
  return (
    typeof call.id === 'string' &&
    call.type === 'function' &&
    typeof call.function?.name === 'string' &&
    typeof call.function?.arguments === 'string'
  );
}

function parseArguments(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeSearchArguments(
  raw: Record<string, unknown>,
  context: ChatContextDto,
):
  | {
      ok: true;
      query: SearchVehiclesQuery;
      arguments: Record<string, unknown>;
      filters: Record<string, unknown>;
    }
  | { ok: false; arguments: Record<string, unknown> } {
  const radiusKm = raw.radiusKm === undefined || raw.radiusKm === null ? 10 : raw.radiusKm;
  const type = optionalValue(raw.type);
  const transmission = optionalValue(raw.transmission);
  const maxPricePerDay = optionalValue(raw.maxPricePerDay);
  const startDate = optionalValue(raw.startDate);
  const endDate = optionalValue(raw.endDate);

  const argumentsForTrace: Record<string, unknown> = {
    lat: context.lat,
    lng: context.lng,
    radiusKm,
  };
  if (type !== undefined) {
    argumentsForTrace.type = type;
  }
  if (transmission !== undefined) {
    argumentsForTrace.transmission = transmission;
  }
  if (maxPricePerDay !== undefined) {
    argumentsForTrace.maxPricePerDay = maxPricePerDay;
  }
  if (startDate !== undefined) {
    argumentsForTrace.startDate = startDate;
  }
  if (endDate !== undefined) {
    argumentsForTrace.endDate = endDate;
  }

  const query = plainToInstance(SearchVehiclesQuery, {
    lat: context.lat,
    lng: context.lng,
    radiusKm,
    type,
    transmission,
    maxPricePerDay,
    startDate,
    endDate,
  });

  return {
    ok: true,
    query,
    arguments: argumentsForTrace,
    filters: { ...argumentsForTrace },
  };
}

function optionalValue(value: unknown): unknown {
  if (value === undefined || value === null) {
    return undefined;
  }
  return value;
}

function joinRanked(
  rows: VehicleSearchResult[],
  body: unknown,
): { ok: true; vehicles: ChatVehicle[] } | { ok: false } {
  if (!Array.isArray(body) || body.length === 0) {
    return { ok: false };
  }

  const byId = new Map(rows.map((row) => [row.id, row]));
  const vehicles: ChatVehicle[] = [];
  for (const item of body) {
    if (!item || typeof item !== 'object') {
      return { ok: false };
    }
    const ranked = item as { id?: unknown; rankScore?: unknown; reason?: unknown };
    if (typeof ranked.id !== 'string') {
      return { ok: false };
    }
    if (typeof ranked.rankScore !== 'number' || typeof ranked.reason !== 'string') {
      return { ok: false };
    }
    const full = byId.get(ranked.id);
    if (!full) {
      continue;
    }
    vehicles.push({
      id: full.id,
      make: full.make,
      model: full.model,
      year: full.year,
      type: full.type,
      transmission: full.transmission,
      fuel: full.fuel,
      seats: full.seats,
      pricePerDay: full.pricePerDay,
      securityDeposit: full.securityDeposit,
      status: full.status,
      currentLat: full.currentLat,
      currentLng: full.currentLng,
      imageUrl: full.imageUrl,
      updatedAt: full.updatedAt,
      distanceKm: full.distanceKm,
      rankScore: ranked.rankScore,
      reason: ranked.reason,
    });
  }

  if (vehicles.length === 0) {
    return { ok: false };
  }
  return { ok: true, vehicles: vehicles.slice(0, 5) };
}

type RuleStep = { name: string; arguments: Record<string, unknown> };

function planRuleSteps(message: string, context: ChatContextDto): RuleStep[] {
  const text = message.trim();
  const vehicleId = mentionedVehicleId(text);
  const dates = mentionedDateArgs(text);
  const idArgs = vehicleId ? { vehicleId } : {};

  if (isPolicyQuestion(text)) {
    return [{ name: 'search_rental_policy', arguments: { query: text } }];
  }
  if (/\breserve\b|\bbook\b/i.test(text)) {
    return [{ name: 'create_reservation', arguments: { ...idArgs, ...dates } }];
  }
  if (/\bcost\b|\bprice\b|\bhow much\b/i.test(text)) {
    return [{ name: 'calculate_rental_price', arguments: { ...idArgs, ...dates } }];
  }
  if (/\bfree\b|\bavailable\b|\bavailability\b/i.test(text)) {
    return [{ name: 'check_availability', arguments: { ...idArgs, ...dates } }];
  }
  if (/\btell me more\b|\bmore about\b|\bdetails\b|\bclosest\b/i.test(text)) {
    if (!vehicleId && !context.activeVehicleId) {
      return [
        { name: 'search_vehicles', arguments: searchRuleArgs(text) },
        { name: 'get_vehicle_details', arguments: {} },
      ];
    }
    return [{ name: 'get_vehicle_details', arguments: { ...idArgs } }];
  }
  if (isVehicleSearch(text)) {
    return [{ name: 'search_vehicles', arguments: searchRuleArgs(text) }];
  }
  return [];
}

function isPolicyQuestion(text: string): boolean {
  return /\bfuel\b|\blate\b|\bcancel|\binsurance\b|\bpolicy\b|\bsecurity deposit\b|\brental guide\b/i.test(
    text,
  );
}

function isVehicleSearch(text: string): boolean {
  return /\bfind\b|\bnear\b|\bsuv\b|\bsedan\b|\bhatchback\b|\bmuv\b|\bautomatic\b|\bmanual\b|\bunder\b/i.test(
    text,
  );
}

function mentionedVehicleId(text: string): string | undefined {
  const matches = [...text.matchAll(/\(([A-Za-z0-9_-]+)\)/g)];
  const id = matches.at(-1)?.[1];
  if (!id || !/[-0-9]/.test(id)) {
    return undefined;
  }
  return id;
}

function mentionedDateArgs(text: string): Record<string, unknown> {
  const found =
    text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z/g) ?? [];
  if (found.length >= 2) {
    return { startDate: found[0], endDate: found[1] };
  }
  if (/\btomorrow\b/i.test(text)) {
    return tomorrowWindow();
  }
  return {};
}

function searchRuleArgs(text: string): Record<string, unknown> {
  const args: Record<string, unknown> = { ...mentionedDateArgs(text) };
  const type = text.match(/\b(suv|sedan|hatchback|muv)\b/i);
  if (type) {
    args.type = type[1].toLowerCase();
  }
  const transmission = text.match(/\b(automatic|manual)\b/i);
  if (transmission) {
    args.transmission = transmission[1].toLowerCase();
  }
  const price = text.match(
    /(?:under|below|up to|maximum|max)\s*(?:inr|rs\.?|₹)?\s*([\d,]+)/i,
  );
  if (price) {
    args.maxPricePerDay = Number(price[1].replace(/,/g, ''));
  }
  return args;
}

function describeRuleOutcome(outcome: ToolOutcome): string {
  if (!outcome.ok) {
    if (outcome.userMessage) {
      return outcome.userMessage;
    }
    const error = outcome.modelPayload.error;
    if (typeof error === 'string') {
      return error;
    }
    if (outcome.name === 'search_rental_policy') {
      return 'The rental guide is unavailable right now.';
    }
    return 'That request could not be completed.';
  }
  if (outcome.name === 'search_vehicles') {
    if (outcome.vehicles.length === 0) {
      return 'No vehicles match those filters.';
    }
    return outcome.vehicles
      .map(
        (vehicle) =>
          `${vehicle.year} ${vehicle.make} ${vehicle.model}: ${vehicle.type}, ${vehicle.transmission}, INR ${vehicle.pricePerDay} per day, ${vehicle.distanceKm} km away.`,
      )
      .join('\n');
  }
  if (outcome.name === 'get_vehicle_details') {
    const vehicle = outcome.modelPayload.vehicle;
    if (!vehicle || typeof vehicle !== 'object') {
      return 'That vehicle was not found.';
    }
    const row = vehicle as {
      year?: unknown;
      make?: unknown;
      model?: unknown;
      seats?: unknown;
      fuel?: unknown;
      securityDeposit?: unknown;
      pricePerDay?: unknown;
    };
    return `${String(row.year)} ${String(row.make)} ${String(row.model)} has ${String(row.seats)} seats, ${String(row.fuel)} fuel, a security deposit of INR ${String(row.securityDeposit)}, and a price of INR ${String(row.pricePerDay)} per day.`;
  }
  if (outcome.name === 'check_availability') {
    if (outcome.modelPayload.available === true) {
      return 'It is free for those dates.';
    }
    const conflicts = outcome.modelPayload.conflicts;
    if (Array.isArray(conflicts) && conflicts.length > 0) {
      return `It is not free. Conflicting reservation: ${conflicts.join(', ')}.`;
    }
    return 'It is not free for those dates.';
  }
  if (outcome.name === 'calculate_rental_price') {
    const price = outcome.modelPayload;
    return `The total is INR ${String(price.totalPrice)} (${String(price.dayCount)} × INR ${String(price.pricePerDay)} per day). The security deposit of INR ${String(price.securityDeposit)} is not included.`;
  }
  if (outcome.name === 'create_reservation' && outcome.reservation) {
    return `Reservation ${outcome.reservation.id} is ${outcome.reservation.status}.`;
  }
  if (outcome.policy?.grounded) {
    return outcome.policy.answer;
  }
  if (outcome.policy) {
    return GUIDE_DOES_NOT_COVER;
  }
  return 'That request could not be completed.';
}
