import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { EXCEPTION_FILTERS_METADATA } from '@nestjs/common/constants';
import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatValidationErrorFilter } from './chat-validation-error.filter.js';
import { ChatController } from './chat.controller.js';
import { ChatService, LlmUnavailableException, tomorrowWindow, VEHICLE_ALREADY_BOOKED } from './chat.service.js';
import { ReservationsService } from '../reservations/reservations.service.js';
import { ChatTurnDto } from './dto/chat-turn.dto.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { VehicleSearchResult } from '../vehicles/vehicles.service.js';
import { VehiclesService } from '../vehicles/vehicles.service.js';

const DEMO =
  'Find me an automatic SUV near me for tomorrow under INR 3,000 per day.';
const START = '2026-10-02T04:30:00.000Z';
const END = '2026-10-03T04:30:00.000Z';

const secrets = {
  DATABASE_URL: 'postgres://sentinel-database-url',
  PASSWORD_HASH: 'sentinel-password-hash',
  AI_SERVICE_URL: 'http://ai.internal',
  AI_SERVICE_TOKEN: 'sentinel-ai-token',
  LLM_BASE_URL: 'http://llm.internal/v1',
  LLM_API_KEY: 'sentinel-llm-key',
  LLM_MODEL: 'gpt-4o-mini',
};

function config(): ConfigService {
  return {
    get: (key: string) => secrets[key as keyof typeof secrets],
  } as unknown as ConfigService;
}

function configWithoutKey(): ConfigService {
  return {
    get: (key: string) => (key === 'LLM_API_KEY' ? '' : secrets[key as keyof typeof secrets]),
  } as unknown as ConfigService;
}

function row(
  partial: Partial<VehicleSearchResult> & { id: string },
): VehicleSearchResult & { anchorLat?: number; anchorLng?: number } {
  return {
    make: 'Hyundai',
    model: 'Creta',
    year: 2022,
    type: 'suv',
    transmission: 'automatic',
    fuel: 'petrol',
    seats: 5,
    pricePerDay: 2800,
    securityDeposit: 5000,
    status: 'available',
    currentLat: 12.97,
    currentLng: 77.64,
    imageUrl: '',
    updatedAt: new Date('2026-09-30T00:00:00.000Z'),
    distanceKm: 1.2,
    anchorLat: 12.97,
    anchorLng: 77.64,
    ...partial,
  };
}

function turn(
  message = DEMO,
  context: Partial<ChatTurnDto['context']> = {},
): ChatTurnDto {
  return {
    message,
    history: [{ role: 'user', content: 'Earlier note' }],
    context: {
      lat: 12.9756,
      lng: 77.6068,
      locationLabel: 'MG Road, Bengaluru',
      timezone: 'Asia/Kolkata',
      activeVehicleId: null,
      activeStart: null,
      activeEnd: null,
      ...context,
    },
  };
}

function toolCall(
  args: Record<string, unknown>,
  id = 'call_1',
  name = 'search_vehicles',
) {
  return {
    id,
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

function completion(content: string | null, toolCalls?: ReturnType<typeof toolCall>[]) {
  return {
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            role: 'assistant',
            content,
            tool_calls: toolCalls,
          },
        },
      ],
    }),
  };
}

function llmBodies(calls: { url: string; init?: RequestInit }[]) {
  return calls
    .filter((call) => call.url.includes('/chat/completions'))
    .map((call) => JSON.parse(String(call.init?.body)) as Record<string, unknown>);
}

describe('ChatService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('ranks a demo search and caps the joined vehicles at five', async () => {
    const matches = [
      row({ id: 'V1', model: 'Creta', pricePerDay: 2800, distanceKm: 3.2 }),
      row({ id: 'V2', model: 'Seltos', make: 'Kia', pricePerDay: 2600, distanceKm: 1.2 }),
      row({ id: 'V6', model: 'Nexon', make: 'Tata', pricePerDay: 2400, distanceKm: 4.1 }),
      row({ id: 'V9', model: 'Hector', make: 'MG', pricePerDay: 3000, distanceKm: 5 }),
      row({ id: 'extra-1', distanceKm: 6 }),
      row({ id: 'extra-2', distanceKm: 7 }),
    ];
    const search = vi.fn().mockResolvedValue(matches);
    const ranked = [...matches].reverse().map((vehicle, index) => ({
      id: vehicle.id,
      distanceKm: vehicle.distanceKm,
      pricePerDay: vehicle.pricePerDay,
      type: vehicle.type,
      transmission: vehicle.transmission,
      rankScore: Number((0.9 - index * 0.01).toFixed(3)),
      reason: `Ranked ${vehicle.model}.`,
    }));
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        if (String(url).includes('/chat/completions')) {
          const prior = calls.filter((call) =>
            call.url.includes('/chat/completions'),
          ).length;
          if (prior === 1) {
            return completion(null, [
              toolCall({
                lat: 0,
                lng: 0,
                type: 'suv',
                transmission: 'automatic',
                maxPricePerDay: 3000,
                startDate: START,
                endDate: END,
              }),
            ]);
          }
          return completion('Four automatic SUVs under 3000 are nearby.');
        }
        if (String(url).endsWith('/rank')) {
          return { ok: true, json: async () => ranked };
        }
        throw new Error(`unexpected ${url}`);
      }),
    );

    const result = await new ChatService(
      { search } as unknown as VehiclesService,
      config(),
    ).turn(
      turn(DEMO, {
        activeVehicleId: 'V2',
        activeStart: START,
        activeEnd: END,
      }),
    );

    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        lat: 12.9756,
        lng: 77.6068,
        radiusKm: 10,
        type: 'suv',
        transmission: 'automatic',
        maxPricePerDay: 3000,
        startDate: START,
        endDate: END,
      }),
    );
    expect(result.reply).toBe('Four automatic SUVs under 3000 are nearby.');
    expect(result.citations).toEqual([]);
    expect(result.reservation).toBeNull();
    expect(result.vehicles).toHaveLength(5);
    expect(result.vehicles.map((vehicle) => vehicle.id)).toEqual(
      ranked.slice(0, 5).map((vehicle) => vehicle.id),
    );
    const shown = ranked.slice(0, 5);
    result.vehicles.forEach((vehicle, index) => {
      const source = matches.find((item) => item.id === shown[index].id);
      expect(vehicle.distanceKm).toBe(source?.distanceKm);
      expect(vehicle.rankScore).toBe(shown[index].rankScore);
      expect(vehicle.reason).toBe(shown[index].reason);
      expect(vehicle).not.toHaveProperty('anchorLat');
      expect(vehicle).not.toHaveProperty('anchorLng');
    });
    expect(result.toolTrace).toEqual([
      {
        name: 'search_vehicles',
        ok: true,
        arguments: expect.objectContaining({
          lat: 12.9756,
          lng: 77.6068,
          type: 'suv',
          startDate: START,
          endDate: END,
        }),
      },
    ]);

    const rankCall = calls.find((call) => call.url.endsWith('/rank'));
    expect(rankCall?.url).toBe('http://ai.internal/rank');
    expect(rankCall?.init?.headers).toMatchObject({
      'X-Service-Token': 'sentinel-ai-token',
    });
    const rankBody = JSON.parse(String(rankCall?.init?.body)) as {
      vehicles: { id: string }[];
      lat?: number;
    };
    expect(rankBody.lat).toBeUndefined();
    expect(rankBody.vehicles).toHaveLength(6);
    expect(calls.some((call) => call.url.includes('/api/vehicles/search'))).toBe(
      false,
    );

    const bodies = llmBodies(calls);
    expect(bodies[0]).toMatchObject({ model: 'gpt-4o-mini', temperature: 0.2 });
    const toolNames = (
      bodies[0].tools as { function: { name: string } }[]
    ).map((tool) => tool.function.name);
    expect(toolNames).toEqual([
      'search_vehicles',
      'get_vehicle_details',
      'check_availability',
      'calculate_rental_price',
      'create_reservation',
      'search_rental_policy',
    ]);
    const messages = bodies[0].messages as { role: string; content: string }[];
    expect(messages[1]).toEqual({ role: 'user', content: 'Earlier note' });
    expect(messages[2]).toEqual({ role: 'user', content: DEMO });
    const system = messages[0].content;
    expect(system).toContain('search_rental_policy');
    expect(system).toContain('must be passed as vehicleId');
    expect(system).toContain(
      'Omit dates only for check_availability, calculate_rental_price, and create_reservation',
    );
    expect(system).toContain(
      'A start and end written in the user message must be passed as startDate and endDate.',
    );
    expect(system).toContain('10:00 Asia/Kolkata');
    expect(system).toContain('The active vehicle id is V2.');
    expect(system).toContain(
      'A location question calls get_vehicle_details for the active vehicle.',
    );
    expect(system).toContain(`The active range is ${START} to ${END}.`);
    const serialized = JSON.stringify(bodies);
    expect(serialized).not.toContain('sentinel-database-url');
    expect(serialized).not.toContain('sentinel-password-hash');
    expect(serialized).not.toContain('sentinel-ai-token');
    expect(serialized).not.toContain('http://ai.internal');
    expect(serialized).not.toContain('sentinel-llm-key');
  });

  it('names filters and skips rank when nothing matches', async () => {
    const search = vi.fn().mockResolvedValue([]);
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        const prior = calls.filter((call) =>
          call.url.includes('/chat/completions'),
        ).length;
        if (prior === 1) {
          return completion(null, [
            toolCall({
              type: 'suv',
              transmission: 'automatic',
              maxPricePerDay: 3000,
              radiusKm: 10,
            }),
          ]);
        }
        return completion(
          'No automatic SUVs at or under 3000 within 10 km.',
        );
      }),
    );

    const result = await new ChatService(
      { search } as unknown as VehiclesService,
      config(),
    ).turn(turn());

    expect(result.vehicles).toEqual([]);
    expect(result.reply).toBe(
      'No automatic SUVs at or under 3000 within 10 km.',
    );
    expect(result.toolTrace[0]).toMatchObject({ name: 'search_vehicles', ok: true });
    expect(calls.some((call) => call.url.endsWith('/rank'))).toBe(false);
    const toolMessage = llmBodies(calls)[1].messages as { role: string; content: string }[];
    const payload = JSON.parse(
      toolMessage.find((message) => message.role === 'tool')!.content,
    ) as { vehicles: unknown[]; filters: Record<string, unknown> };
    expect(payload.vehicles).toEqual([]);
    expect(payload.filters).toMatchObject({
      type: 'suv',
      transmission: 'automatic',
      maxPricePerDay: 3000,
      radiusKm: 10,
    });
  });

  it('returns plain language and no vehicles when ranking fails', async () => {
    const search = vi.fn().mockResolvedValue([row({ id: 'V1' })]);
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        if (String(url).endsWith('/rank')) {
          return { ok: false, status: 500, json: async () => ({}) };
        }
        const prior = calls.filter((call) =>
          call.url.includes('/chat/completions'),
        ).length;
        if (prior === 1) {
          return completion(null, [toolCall({ type: 'suv' })]);
        }
        return completion('I could not rank vehicles just now.');
      }),
    );

    const result = await new ChatService(
      { search } as unknown as VehiclesService,
      config(),
    ).turn(turn());

    expect(result.vehicles).toEqual([]);
    expect(result.reply).toBe('I could not rank vehicles just now.');
    expect(result.toolTrace).toEqual([
      expect.objectContaining({ name: 'search_vehicles', ok: false }),
    ]);
    const toolMessage = llmBodies(calls)[1].messages as { role: string; content: string }[];
    const payload = JSON.parse(
      toolMessage.find((message) => message.role === 'tool')!.content,
    ) as { ok: boolean; vehicles?: unknown };
    expect(payload).toEqual({ ok: false, error: 'Ranking failed.' });
    expect(payload.vehicles).toBeUndefined();
  });

  it('treats a rank timeout as a tool failure', async () => {
    const search = vi.fn().mockResolvedValue([row({ id: 'V1' })]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).endsWith('/rank')) {
          throw new Error('timeout');
        }
        const initCount = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
          (call) => String(call[0]).includes('/chat/completions'),
        ).length;
        if (initCount === 1) {
          return completion(null, [toolCall({ type: 'suv' })]);
        }
        return completion('I could not rank vehicles just now.');
      }),
    );

    const result = await new ChatService(
      { search } as unknown as VehiclesService,
      config(),
    ).turn(turn());

    expect(result.toolTrace[0].ok).toBe(false);
    expect(result.vehicles).toEqual([]);
  });

  it('returns LLM_UNAVAILABLE when the model cannot be reached', async () => {
    const search = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    await expect(
      new ChatService({ search } as unknown as VehiclesService, config()).turn(turn()),
    ).rejects.toBeInstanceOf(LlmUnavailableException);

    try {
      await new ChatService(
        { search } as unknown as VehiclesService,
        config(),
      ).turn(turn());
    } catch (error) {
      expect((error as LlmUnavailableException).getResponse()).toEqual({
        statusCode: 503,
        code: 'LLM_UNAVAILABLE',
        message: 'The assistant is unavailable right now.',
      });
    }
    expect(search).not.toHaveBeenCalled();
  });

  it('returns LLM_UNAVAILABLE when the 20s budget is spent', async () => {
    const search = vi.fn();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValueOnce(1_000);
    now.mockReturnValue(21_001);

    await expect(
      new ChatService({ search } as unknown as VehiclesService, config()).turn(turn()),
    ).rejects.toMatchObject({
      response: {
        statusCode: 503,
        code: 'LLM_UNAVAILABLE',
        message: 'The assistant is unavailable right now.',
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it('answers a demo search from rules when no model key is set', async () => {
    const matches = [
      row({ id: 'V2', model: 'Seltos', make: 'Kia', pricePerDay: 2600, distanceKm: 1.2 }),
    ];
    const search = vi.fn().mockResolvedValue(matches);
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(String(url));
        if (String(url).endsWith('/rank')) {
          return {
            ok: true,
            json: async () => [
              { id: 'V2', rankScore: 0.9, reason: 'Closest automatic SUV within the budget.' },
            ],
          };
        }
        throw new Error(`unexpected ${url}`);
      }),
    );
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-10-01T12:00:00.000Z').getTime());

    const result = await new ChatService(
      { search } as unknown as VehiclesService,
      configWithoutKey(),
    ).turn(turn(DEMO));

    expect(calls.some((url) => url.includes('/chat/completions'))).toBe(false);
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'suv',
        transmission: 'automatic',
        maxPricePerDay: 3000,
        startDate: '2026-10-02T04:30:00.000Z',
        endDate: '2026-10-03T04:30:00.000Z',
      }),
    );
    expect(result.reply).toContain('Kia Seltos');
    expect(result.reply).toContain('automatic');
    expect(result.reply).toContain('INR 2600 per day');
    expect(result.reply).toContain('1.2 km away');
    expect(result.vehicles.map((vehicle) => vehicle.id)).toEqual(['V2']);
    expect(result.toolTrace[0]).toMatchObject({ name: 'search_vehicles', ok: true });
  });

  it('uses rules when the provider rejects the key', async () => {
    const search = vi.fn().mockResolvedValue([
      row({ id: 'V2', model: 'Seltos', make: 'Kia', pricePerDay: 2600, distanceKm: 1.2 }),
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/chat/completions')) {
          return { ok: false, status: 401, json: async () => ({}) };
        }
        if (String(url).endsWith('/rank')) {
          return {
            ok: true,
            json: async () => [{ id: 'V2', rankScore: 0.9, reason: 'Closest.' }],
          };
        }
        throw new Error(`unexpected ${url}`);
      }),
    );

    const result = await new ChatService(
      { search } as unknown as VehiclesService,
      config(),
    ).turn(turn(DEMO));

    expect(search).toHaveBeenCalled();
    expect(result.reply).toContain('Kia Seltos');
  });

  it('does not run the rules after a rejected key follows a completed tool', async () => {
    const search = vi.fn().mockResolvedValue([row({ id: 'V1' })]);
    let llmCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/chat/completions')) {
          llmCalls += 1;
          if (llmCalls === 1) {
            return completion(null, [toolCall({ type: 'suv' })]);
          }
          return { ok: false, status: 401, json: async () => ({}) };
        }
        if (String(url).endsWith('/rank')) {
          return {
            ok: true,
            json: async () => [{ id: 'V1', rankScore: 0.5, reason: 'Ranked.' }],
          };
        }
        throw new Error(`unexpected ${url}`);
      }),
    );

    await expect(
      new ChatService({ search } as unknown as VehiclesService, config()).turn(turn(DEMO)),
    ).rejects.toBeInstanceOf(LlmUnavailableException);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('describes, prices, and reserves the active vehicle from rules', async () => {
    const details = vi.fn().mockResolvedValue({
      id: 'near-seltos',
      year: 2023,
      make: 'Kia',
      model: 'Seltos',
      seats: 5,
      fuel: 'petrol',
      securityDeposit: 5000,
      pricePerDay: 2600,
    });
    const availability = vi.fn().mockResolvedValue({ available: true });
    const price = vi.fn().mockResolvedValue({
      dayCount: 1,
      pricePerDay: 2600,
      totalPrice: 2600,
      securityDeposit: 5000,
      currency: 'INR',
    });
    const create = vi.fn().mockResolvedValue({
      id: 'res-1',
      vehicleId: 'near-seltos',
      year: 2023,
      make: 'Kia',
      model: 'Seltos',
      startAt: '2026-10-02T04:30:00.000Z',
      endAt: '2026-10-03T04:30:00.000Z',
      dayCount: 1,
      pricePerDay: 2600,
      totalPrice: 2600,
      securityDeposit: 5000,
      currency: 'INR',
      status: 'confirmed',
      createdAt: '2026-10-01T12:00:00.000Z',
    });
    const vehicles = { details, availability, price } as unknown as VehiclesService;
    const reservations = { create } as unknown as ReservationsService;
    const service = new ChatService(vehicles, configWithoutKey(), reservations);
    const context = { activeVehicleId: 'near-seltos' };

    const described = await service.turn(turn('Tell me more about the closest one.', context));
    const free = await service.turn(turn('Is it free tomorrow?', context));
    const cost = await service.turn(turn('What will it cost for tomorrow?', context));
    const booked = await service.turn(turn('Reserve it for tomorrow.', context), 'priya-user');

    expect(described.reply).toContain('2023 Kia Seltos has 5 seats, petrol fuel');
    expect(described.reply).toContain('INR 5000');
    expect(described.reply).toContain('INR 2600 per day');
    expect(free.reply).toBe('It is free for those dates.');
    expect(cost.reply).toBe(
      'The total is INR 2600 (1 × INR 2600 per day). The security deposit of INR 5000 is not included.',
    );
    expect(booked.reply).toBe('Reservation res-1 is confirmed.');
    expect(booked.reservation?.id).toBe('res-1');
    expect(create).toHaveBeenCalledWith(
      'priya-user',
      expect.objectContaining({ vehicleId: 'near-seltos' }),
    );
  });

  it('stops after five tool rounds and answers without tools', async () => {
    const search = vi.fn().mockResolvedValue([row({ id: 'V1' })]);
    let llmCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/rank')) {
          return {
            ok: true,
            json: async () => [
              {
                id: 'V1',
                rankScore: 0.5,
                reason: 'Closest automatic SUV within the budget.',
              },
            ],
          };
        }
        llmCalls += 1;
        const body = JSON.parse(String(init?.body)) as { tools?: unknown };
        if (llmCalls <= 5) {
          expect(body.tools).toBeDefined();
          return completion(null, [toolCall({ type: 'suv' }, `call_${llmCalls}`)]);
        }
        expect(body.tools).toBeUndefined();
        return completion('Here is the last answer.');
      }),
    );

    const result = await new ChatService(
      { search } as unknown as VehiclesService,
      config(),
    ).turn(turn());

    expect(llmCalls).toBe(6);
    expect(search).toHaveBeenCalledTimes(5);
    expect(result.reply).toBe('Here is the last answer.');
    expect(result.toolTrace).toHaveLength(5);
    expect(result.vehicles).toHaveLength(1);
  });

  it('rejects invalid filters and a tool that is not registered', async () => {
    const search = vi.fn().mockResolvedValue([row({ id: 'V1' })]);
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        const prior = calls.filter((call) =>
          call.url.includes('/chat/completions'),
        ).length;
        if (prior === 1) {
          return completion(null, [
            toolCall({ radiusKm: 80 }),
            {
              id: 'call_other',
              type: 'function',
              function: {
                name: 'not_a_tool',
                arguments: JSON.stringify({ vehicleId: 'V1' }),
              },
            },
          ]);
        }
        return completion('I could not run that search.');
      }),
    );

    const result = await new ChatService(
      { search } as unknown as VehiclesService,
      config(),
    ).turn(turn());

    expect(search).not.toHaveBeenCalled();
    expect(calls.some((call) => call.url.endsWith('/rank'))).toBe(false);
    expect(result.vehicles).toEqual([]);
    expect(result.toolTrace).toEqual([
      expect.objectContaining({ name: 'search_vehicles', ok: false }),
      expect.objectContaining({ name: 'not_a_tool', ok: false }),
    ]);
    const toolMessages = (
      llmBodies(calls)[1].messages as { role: string; content: string }[]
    ).filter((message) => message.role === 'tool');
    expect(JSON.parse(toolMessages[0].content)).toEqual({
      ok: false,
      error: 'Search filters are not valid.',
    });
    expect(JSON.parse(toolMessages[1].content)).toEqual({
      ok: false,
      error: 'That tool is not available.',
    });
  });

  it('returns LLM_UNAVAILABLE when completions is not ok but still has a message', async () => {
    const search = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: async () => ({
          message: 'Invented Creta is 1 km away.',
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Invented Creta is 1 km away.',
              },
            },
          ],
        }),
      }),
    );

    await expect(
      new ChatService({ search } as unknown as VehiclesService, config()).turn(turn()),
    ).rejects.toMatchObject({
      response: {
        statusCode: 503,
        code: 'LLM_UNAVAILABLE',
        message: 'The assistant is unavailable right now.',
      },
    });
    expect(search).not.toHaveBeenCalled();
  });

  it('uses the closest vehicle and tomorrow for details, availability, and price', async () => {
    const stored = dbVehicle({
      id: 'near-seltos',
      pricePerDay: 2600,
      securityDeposit: 5000,
      currentLat: 12.9756,
      currentLng: 77.6068,
    });
    const { service, reservationFindMany } = vehicleReader(stored, []);
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        const prior = calls.filter((call) =>
          call.url.includes('/chat/completions'),
        ).length;
        if (prior === 1) {
          return completion(null, [
            toolCall({}, 'd1', 'get_vehicle_details'),
            toolCall({}, 'd2', 'check_availability'),
            toolCall({}, 'd3', 'calculate_rental_price'),
          ]);
        }
        return completion('The closest vehicle is 2600 for 1 day.');
      }),
    );

    const now = new Date('2026-10-01T12:00:00.000Z');
    vi.spyOn(Date, 'now').mockReturnValue(now.getTime());
    expect(tomorrowWindow(now)).toEqual({
      startDate: '2026-10-02T04:30:00.000Z',
      endDate: '2026-10-03T04:30:00.000Z',
    });

    const result = await new ChatService(service, config()).turn(
      turn('Tell me about the closest one tomorrow and the cost.', {
        activeVehicleId: 'near-seltos',
      }),
    );
    expect(result.toolTrace.map((entry) => entry.name)).toEqual([
      'get_vehicle_details',
      'check_availability',
      'calculate_rental_price',
    ]);
    expect(result.toolTrace.every((entry) => entry.ok)).toBe(true);
    for (const entry of result.toolTrace) {
      expect(entry.arguments.vehicleId).toBe('near-seltos');
    }
    expect(result.toolTrace[1]?.arguments).toMatchObject({
      startDate: '2026-10-02T04:30:00.000Z',
      endDate: '2026-10-03T04:30:00.000Z',
    });
    expect(result.toolTrace[2]?.arguments).toMatchObject({
      startDate: '2026-10-02T04:30:00.000Z',
      endDate: '2026-10-03T04:30:00.000Z',
    });
    const payloads = await toolPayloads(calls);
    expect(payloads[0]).toMatchObject({
      ok: true,
      vehicle: { id: 'near-seltos', distanceKm: 0, pricePerDay: 2600 },
    });
    expect(payloads[0]).not.toHaveProperty('vehicle.anchorLat');
    expect(JSON.stringify(payloads[0])).not.toContain('anchorLat');
    expect(payloads[1]).toEqual({ ok: true, available: true });
    expect(payloads[2]).toEqual({
      ok: true,
      dayCount: 1,
      pricePerDay: 2600,
      totalPrice: 2600,
      securityDeposit: 5000,
      currency: 'INR',
    });
    expect(reservationFindMany).toHaveBeenCalled();
    expect(calls.some((call) => call.url.endsWith('/rank'))).toBe(false);
  });

  it('keeps a supplied id and uses stored dates instead of tomorrow', async () => {
    const stored = dbVehicle({ id: 'far-creta', pricePerDay: 2800 });
    const { service } = vehicleReader(stored, []);
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        const prior = calls.filter((call) =>
          call.url.includes('/chat/completions'),
        ).length;
        if (prior === 1) {
          return completion(null, [
            toolCall(
              { vehicleId: 'far-creta', startDate: START, endDate: END },
              'p1',
              'calculate_rental_price',
            ),
          ]);
        }
        return completion('2800 for one day.');
      }),
    );

    const result = await new ChatService(service, config()).turn(
      turn('What does this one cost?', {
        activeVehicleId: 'near-seltos',
        activeStart: '2026-11-01T04:30:00.000Z',
        activeEnd: '2026-11-03T04:30:00.000Z',
      }),
    );

    expect(result.toolTrace[0]?.arguments).toMatchObject({
      vehicleId: 'far-creta',
      startDate: START,
      endDate: END,
    });
    expect((await toolPayloads(calls))[0]).toMatchObject({
      ok: true,
      dayCount: 1,
      pricePerDay: 2800,
      totalPrice: 2800,
    });
  });

  it('fills missing dates from the active range', async () => {
    const { service } = vehicleReader(dbVehicle({ id: 'V1', pricePerDay: 2800 }), []);
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        const prior = calls.filter((call) =>
          call.url.includes('/chat/completions'),
        ).length;
        if (prior === 1) {
          return completion(null, [
            toolCall({}, 'r1', 'calculate_rental_price'),
          ]);
        }
        return completion('5600 for two days.');
      }),
    );

    const activeStart = '2026-11-01T04:30:00.000Z';
    const activeEnd = '2026-11-03T04:30:00.000Z';
    const result = await new ChatService(service, config()).turn(
      turn('What will it cost?', {
        activeVehicleId: 'V1',
        activeStart,
        activeEnd,
      }),
    );

    expect(result.toolTrace[0]?.arguments).toMatchObject({
      vehicleId: 'V1',
      startDate: activeStart,
      endDate: activeEnd,
    });
    expect((await toolPayloads(calls))[0]).toMatchObject({
      dayCount: 2,
      pricePerDay: 2800,
      totalPrice: 5600,
      securityDeposit: 5000,
    });
  });

  it('rejects a one-sided date without pricing or checking availability', async () => {
    const price = vi.fn();
    const availability = vi.fn();
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        const prior = calls.filter((call) =>
          call.url.includes('/chat/completions'),
        ).length;
        if (prior === 1) {
          return completion(null, [
            toolCall(
              { vehicleId: 'V1', startDate: START },
              'o1',
              'calculate_rental_price',
            ),
            toolCall({ vehicleId: 'V1', endDate: END }, 'o2', 'check_availability'),
          ]);
        }
        return completion('Those dates are not valid.');
      }),
    );

    const result = await new ChatService(
      { price, availability, search: vi.fn() } as unknown as VehiclesService,
      config(),
    ).turn(
      turn('What will it cost?', {
        activeVehicleId: 'V1',
        activeStart: START,
        activeEnd: END,
      }),
    );

    expect(price).not.toHaveBeenCalled();
    expect(availability).not.toHaveBeenCalled();
    expect(result.toolTrace).toEqual([
      expect.objectContaining({ name: 'calculate_rental_price', ok: false }),
      expect.objectContaining({ name: 'check_availability', ok: false }),
    ]);
    const payloads = await toolPayloads(calls);
    expect(payloads[0]).toEqual({ ok: false, error: 'Dates are not valid.' });
    expect(payloads[1]).toEqual({ ok: false, error: 'Dates are not valid.' });
  });

  it('reports overlapping confirmed reservations for tomorrow', async () => {
    const { service, reservationFindMany } = vehicleReader(dbVehicle({ id: 'V1' }), [
      { id: 'res-9' },
    ]);
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        const prior = calls.filter((call) =>
          call.url.includes('/chat/completions'),
        ).length;
        if (prior === 1) {
          return completion(null, [
            toolCall({}, 'a1', 'check_availability'),
          ]);
        }
        return completion('That vehicle is already booked.');
      }),
    );

    const result = await new ChatService(service, config()).turn(
      turn('Is the closest one free tomorrow?', { activeVehicleId: 'V1' }),
    );

    const window = tomorrowWindow();
    expect(reservationFindMany).toHaveBeenCalledWith({
      where: {
        vehicleId: 'V1',
        status: 'confirmed',
        startAt: { lt: new Date(window.endDate) },
        endAt: { gt: new Date(window.startDate) },
      },
      select: { id: true },
    });
    expect(result.toolTrace[0]).toMatchObject({
      name: 'check_availability',
      ok: true,
      arguments: { vehicleId: 'V1' },
    });
    expect((await toolPayloads(calls))[0]).toEqual({
      ok: true,
      available: false,
      conflicts: ['res-9'],
    });
  });

  it('reports a maintenance vehicle as unavailable', async () => {
    const { service } = vehicleReader(
      dbVehicle({ id: 'V10', status: 'maintenance' }),
      [],
    );
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        const prior = calls.filter((call) =>
          call.url.includes('/chat/completions'),
        ).length;
        if (prior === 1) {
          return completion(null, [
            toolCall({ vehicleId: 'V10' }, 'm1', 'check_availability'),
          ]);
        }
        return completion('That vehicle is not available.');
      }),
    );

    await new ChatService(service, config()).turn(
      turn('Is it free tomorrow?', { activeVehicleId: 'V1' }),
    );

    expect((await toolPayloads(calls))[0]).toEqual({
      ok: true,
      available: false,
      conflicts: [],
    });
  });

  it('returns ok false for an unknown vehicle and does not invent a price', async () => {
    const { service, findUnique } = vehicleReader(null, []);
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        const prior = calls.filter((call) =>
          call.url.includes('/chat/completions'),
        ).length;
        if (prior === 1) {
          return completion(null, [
            toolCall({ vehicleId: 'missing' }, 'u1', 'get_vehicle_details'),
            toolCall({ vehicleId: 'missing' }, 'u2', 'calculate_rental_price'),
          ]);
        }
        return completion('I could not find that vehicle.');
      }),
    );

    const result = await new ChatService(service, config()).turn(
      turn('How much is missing?', { activeVehicleId: 'V1' }),
    );

    expect(findUnique).toHaveBeenCalledWith({ where: { id: 'missing' } });
    expect(result.vehicles).toEqual([]);
    expect(result.toolTrace).toEqual([
      expect.objectContaining({
        name: 'get_vehicle_details',
        ok: false,
        arguments: { vehicleId: 'missing' },
      }),
      expect.objectContaining({
        name: 'calculate_rental_price',
        ok: false,
        arguments: expect.objectContaining({ vehicleId: 'missing' }),
      }),
    ]);
    const payloads = await toolPayloads(calls);
    expect(payloads[0]).toEqual({ ok: false });
    expect(payloads[1]).toEqual({ ok: false });
    expect(JSON.stringify(payloads)).not.toContain('pricePerDay');
    expect(JSON.stringify(payloads)).not.toContain('totalPrice');
  });

  it('reserves the closest vehicle for tomorrow and repeats the same booking', async () => {
    const store = reservationStore(bookableVehicle());
    const calls = scriptReserve(undefined, 'Reserved.');
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-10-01T12:00:00.000Z').getTime());

    const first = await store.chat.turn(
      turn('Reserve it for tomorrow.', { activeVehicleId: 'near-seltos' }),
      'priya-user',
    );

    expect(store.create).toHaveBeenCalledTimes(1);
    expect(store.create.mock.calls[0][0].data).toMatchObject({
      userId: 'priya-user',
      vehicleId: 'near-seltos',
      status: 'confirmed',
      currency: 'INR',
      dayCount: 1,
      pricePerDay: 2600,
      totalPrice: 2600,
      startAt: new Date('2026-10-02T04:30:00.000Z'),
      endAt: new Date('2026-10-03T04:30:00.000Z'),
    });
    expect(store.vehicleUpdate).not.toHaveBeenCalled();
    expect(first.reservation).toMatchObject({
      id: 'res-1',
      year: 2023,
      make: 'Kia',
      model: 'Seltos',
      dayCount: 1,
      pricePerDay: 2600,
      totalPrice: 2600,
      currency: 'INR',
      status: 'confirmed',
      startAt: '2026-10-02T04:30:00.000Z',
      endAt: '2026-10-03T04:30:00.000Z',
    });
    expect(first.reservation).not.toHaveProperty('userId');
    expect(first.reservation?.securityDeposit).toBe(5000);
    const payloads = await toolPayloads(calls);
    expect(payloads[0]).toMatchObject({
      ok: true,
      reservation: { id: 'res-1', securityDeposit: 5000 },
    });
    expect(JSON.stringify(payloads[0])).not.toContain('priya-user');
    expect(calls.some((call) => call.url.endsWith('/rank'))).toBe(false);

    const second = await store.chat.turn(
      turn('Reserve it for tomorrow.', { activeVehicleId: 'near-seltos' }),
      'priya-user',
    );
    expect(second.reservation?.id).toBe('res-1');
    expect(store.create).toHaveBeenCalledTimes(1);
    expect(store.rows).toHaveLength(1);
  });

  it('keeps a vehicle id supplied by the model and ignores a model user id', async () => {
    const store = reservationStore(bookableVehicle({ id: 'far-creta', make: 'Hyundai', model: 'Creta' }));
    scriptReserve({
      vehicleId: 'far-creta',
      userId: 'attacker',
      startDate: '2026-10-02T10:00:00+05:30',
      endDate: '2026-10-03T10:00:00+05:30',
    });

    const result = await store.chat.turn(
      turn('Reserve Hyundai Creta (far-creta) from 2026-10-02T10:00:00+05:30 to 2026-10-03T10:00:00+05:30.', {
        activeVehicleId: 'near-seltos',
      }),
      'priya-user',
    );

    expect(store.create.mock.calls[0][0].data.userId).toBe('priya-user');
    expect(store.create.mock.calls[0][0].data.vehicleId).toBe('far-creta');
    expect(store.create.mock.calls[0][0].data.startAt).toEqual(new Date('2026-10-02T04:30:00.000Z'));
    expect(result.toolTrace[0]?.arguments).toEqual({
      vehicleId: 'far-creta',
      startDate: '2026-10-02T10:00:00+05:30',
      endDate: '2026-10-03T10:00:00+05:30',
    });
    expect(result.toolTrace[0]?.arguments).not.toHaveProperty('userId');
  });

  it('keeps the first reservation when a later create_reservation fails', async () => {
    const store = reservationStore(bookableVehicle());
    store.rows.push(
      storedReservation({
        id: 'res-other',
        userId: 'other-user',
        startAt: new Date('2026-10-04T04:30:00.000Z'),
        endAt: new Date('2026-10-05T04:30:00.000Z'),
      }),
    );
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        const body = JSON.parse(String(init?.body)) as { messages?: { role: string }[] };
        const last = body.messages?.[body.messages.length - 1];
        if (last?.role === 'user') {
          return completion(null, [
            toolCall({}, 'book_1', 'create_reservation'),
            toolCall(
              {
                startDate: '2026-10-04T04:30:00.000Z',
                endDate: '2026-10-05T04:30:00.000Z',
              },
              'book_2',
              'create_reservation',
            ),
          ]);
        }
        return completion('Reserved the first vehicle.');
      }),
    );
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-10-01T12:00:00.000Z').getTime());

    const result = await store.chat.turn(
      turn('Reserve it for tomorrow.', { activeVehicleId: 'near-seltos' }),
      'priya-user',
    );

    expect(store.create).toHaveBeenCalledTimes(1);
    expect(result.reservation?.id).toBe('res-2');
    expect(store.rows.map((row) => row.id)).toEqual(['res-other', 'res-2']);
    expect(result.reply).toBe('Reserved the first vehicle.');
    expect(result.reply).not.toBe(VEHICLE_ALREADY_BOOKED);
    const payloads = await toolPayloads(calls);
    expect(payloads[0]).toMatchObject({ ok: true, reservation: { id: 'res-2' } });
    expect(payloads[1]).toEqual({ ok: false });
  });

  it('tells the user when create throws an unexpected error', async () => {
    const store = reservationStore(bookableVehicle());
    store.create.mockRejectedValueOnce(new Error('database unavailable'));
    scriptReserve(undefined, 'Booked!');
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-10-01T12:00:00.000Z').getTime());

    const result = await store.chat.turn(
      turn('Reserve it for tomorrow.', { activeVehicleId: 'near-seltos' }),
      'priya-user',
    );

    expect(result.reservation).toBeNull();
    expect(result.reply).toBe('That reservation could not be completed.');
    expect(store.rows).toHaveLength(0);
  });

  it('rejects a different overlap without a second row', async () => {
    const store = reservationStore(bookableVehicle());
    store.rows.push(
      storedReservation({
        id: 'res-other',
        userId: 'other-user',
        startAt: new Date('2026-10-02T00:00:00.000Z'),
        endAt: new Date('2026-10-02T12:00:00.000Z'),
      }),
    );
    const calls = scriptReserve(undefined, 'Booked!');
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-10-01T12:00:00.000Z').getTime());

    const result = await store.chat.turn(
      turn('Reserve it for tomorrow.', { activeVehicleId: 'near-seltos' }),
      'priya-user',
    );

    expect(store.create).not.toHaveBeenCalled();
    expect(store.rows).toHaveLength(1);
    expect(result.reservation).toBeNull();
    expect(result.reply).toBe(VEHICLE_ALREADY_BOOKED);
    expect(await toolPayloads(calls)).toEqual([{ ok: false }]);
  });

  it('creates a confirmed row when only a cancelled reservation overlaps', async () => {
    const store = reservationStore(bookableVehicle());
    store.rows.push(
      storedReservation({
        id: 'res-cancelled',
        status: 'cancelled',
        startAt: new Date('2026-10-02T04:30:00.000Z'),
        endAt: new Date('2026-10-03T04:30:00.000Z'),
      }),
    );
    scriptReserve();
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-10-01T12:00:00.000Z').getTime());

    const result = await store.chat.turn(
      turn('Reserve it for tomorrow.', { activeVehicleId: 'near-seltos' }),
      'priya-user',
    );

    expect(store.create).toHaveBeenCalledTimes(1);
    expect(result.reservation?.status).toBe('confirmed');
    expect(result.reservation?.id).toBe('res-2');
    expect(store.findMany.mock.calls[0][0].where.status).toBe('confirmed');
  });

  it('does not reserve a maintenance vehicle', async () => {
    const store = reservationStore(bookableVehicle({ status: 'maintenance' }));
    const calls = scriptReserve(undefined, 'Booked!');
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-10-01T12:00:00.000Z').getTime());

    const result = await store.chat.turn(
      turn('Reserve it for tomorrow.', { activeVehicleId: 'near-seltos' }),
      'priya-user',
    );

    expect(store.create).not.toHaveBeenCalled();
    expect(store.rows).toHaveLength(0);
    expect(result.reservation).toBeNull();
    expect(result.reply).toBe('This vehicle cannot be reserved.');
    expect(await toolPayloads(calls)).toEqual([{ ok: false }]);
  });

  it('reports an unknown vehicle without creating a row', async () => {
    const store = reservationStore(null);
    const calls = scriptReserve({ vehicleId: 'missing' });

    const result = await store.chat.turn(
      turn('Reserve missing (missing) for tomorrow.'),
      'priya-user',
    );

    expect(store.create).not.toHaveBeenCalled();
    expect(result.reservation).toBeNull();
    expect(result.reply).toBe('That vehicle was not found.');
    expect(await toolPayloads(calls)).toEqual([{ ok: false }]);
  });
});

type StoredReservation = {
  id: string;
  userId: string;
  vehicleId: string;
  status: string;
  startAt: Date;
  endAt: Date;
  dayCount: number;
  pricePerDay: number;
  totalPrice: number;
  currency: string;
  createdAt: Date;
  vehicle: {
    year: number;
    make: string;
    model: string;
    securityDeposit: number;
  };
};

function bookableVehicle(
  partial: Record<string, unknown> = {},
) {
  return {
    id: 'near-seltos',
    make: 'Kia',
    model: 'Seltos',
    year: 2023,
    type: 'suv',
    transmission: 'automatic',
    fuel: 'petrol',
    seats: 5,
    pricePerDay: 2600,
    securityDeposit: 5000,
    status: 'available',
    currentLat: 12.9756,
    currentLng: 77.6068,
    anchorLat: 12.97,
    anchorLng: 77.64,
    imageUrl: '',
    updatedAt: new Date('2026-09-30T00:00:00.000Z'),
    ...partial,
  };
}

function storedReservation(
  partial: Partial<StoredReservation> = {},
): StoredReservation {
  const vehicle = bookableVehicle();
  return {
    id: 'res-seed',
    userId: 'priya-user',
    vehicleId: 'near-seltos',
    status: 'confirmed',
    startAt: new Date(START),
    endAt: new Date(END),
    dayCount: 1,
    pricePerDay: 2600,
    totalPrice: 2600,
    currency: 'INR',
    createdAt: new Date('2026-10-01T08:00:00.000Z'),
    vehicle: {
      year: vehicle.year,
      make: vehicle.make,
      model: vehicle.model,
      securityDeposit: vehicle.securityDeposit,
    },
    ...partial,
  };
}

function reservationStore(vehicle: ReturnType<typeof bookableVehicle> | null) {
  const rows: StoredReservation[] = [];
  const vehicleUpdate = vi.fn();
  const findMany = vi.fn(
    async (args: {
      where: {
        status?: string;
        vehicleId?: string;
        startAt?: { lt: Date };
        endAt?: { gt: Date };
      };
    }) =>
      rows
        .filter((row) => {
          const where = args.where;
          if (where.status && row.status !== where.status) {
            return false;
          }
          if (where.vehicleId && row.vehicleId !== where.vehicleId) {
            return false;
          }
          if (where.startAt && !(row.startAt.getTime() < where.startAt.lt.getTime())) {
            return false;
          }
          if (where.endAt && !(row.endAt.getTime() > where.endAt.gt.getTime())) {
            return false;
          }
          return true;
        })
        .map((row) => ({ id: row.id })),
  );
  const findFirst = vi.fn(
    async (args: {
      where: {
        userId?: string;
        vehicleId?: string;
        status?: string;
        startAt?: Date;
        endAt?: Date;
      };
    }) =>
      rows.find((row) => {
        const where = args.where;
        return (
          row.userId === where.userId &&
          row.vehicleId === where.vehicleId &&
          row.status === where.status &&
          where.startAt instanceof Date &&
          where.endAt instanceof Date &&
          row.startAt.getTime() === where.startAt.getTime() &&
          row.endAt.getTime() === where.endAt.getTime()
        );
      }) ?? null,
  );
  const create = vi.fn(async (args: { data: Record<string, unknown> }) => {
    const row = storedReservation({
      id: `res-${rows.length + 1}`,
      ...(args.data as Partial<StoredReservation>),
      vehicle: vehicle
        ? {
            year: vehicle.year,
            make: vehicle.make,
            model: vehicle.model,
            securityDeposit: vehicle.securityDeposit,
          }
        : storedReservation().vehicle,
    });
    rows.push(row);
    return row;
  });
  const db = {
    vehicle: {
      findUnique: vi.fn(async () => vehicle),
      update: vehicleUpdate,
      findMany: vi.fn(),
    },
    reservation: { findFirst, findMany, create },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  const vehicles = new VehiclesService(db as unknown as PrismaService);
  const reservations = new ReservationsService(db as unknown as PrismaService, vehicles);
  return {
    rows,
    create,
    findMany,
    vehicleUpdate,
    chat: new ChatService(vehicles, config(), reservations),
  };
}

function scriptReserve(
  toolArgs: Record<string, unknown> = {},
  finalReply = 'Your reservation is confirmed.',
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      const body = JSON.parse(String(init?.body)) as { messages?: { role: string }[] };
      const last = body.messages?.[body.messages.length - 1];
      if (last?.role === 'user') {
        return completion(null, [toolCall(toolArgs, 'book_1', 'create_reservation')]);
      }
      return completion(finalReply);
    }),
  );
  return calls;
}

function dbVehicle(
  partial: Partial<VehicleSearchResult> & { id: string },
): VehicleSearchResult & { anchorLat: number; anchorLng: number } {
  return {
    ...row(partial),
    anchorLat: 12.97,
    anchorLng: 77.64,
  };
}

function vehicleReader(
  vehicle: ReturnType<typeof dbVehicle> | null,
  reservations: { id: string }[],
) {
  const findUnique = vi.fn().mockResolvedValue(vehicle);
  const reservationFindMany = vi.fn().mockResolvedValue(reservations);
  const service = new VehiclesService({
    vehicle: { findUnique, findMany: vi.fn() },
    reservation: { findMany: reservationFindMany },
  } as unknown as PrismaService);
  return { service, findUnique, reservationFindMany };
}

async function toolPayloads(calls: { url: string; init?: RequestInit }[]) {
  const bodies = llmBodies(calls as { url: string; init?: RequestInit }[]);
  const messages = bodies[1].messages as { role: string; content: string }[];
  return messages
    .filter((message) => message.role === 'tool')
    .map((message) => JSON.parse(message.content) as Record<string, unknown>);
}

describe('bad chat body', () => {
  it('returns VALIDATION_ERROR when message or coordinates are missing', async () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    const cases = [
      {
        context: {
          lat: 12.9756,
          lng: 77.6068,
          locationLabel: 'MG Road, Bengaluru',
          timezone: 'Asia/Kolkata',
        },
      },
      {
        message: DEMO,
        context: {
          lng: 77.6068,
          locationLabel: 'MG Road, Bengaluru',
          timezone: 'Asia/Kolkata',
        },
      },
      {
        message: DEMO,
        context: {
          lat: 12.9756,
          locationLabel: 'MG Road, Bengaluru',
          timezone: 'Asia/Kolkata',
        },
      },
    ];

    for (const plain of cases) {
      await expect(
        pipe.transform(plain, { type: 'body', metatype: ChatTurnDto }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }

    const json = vi.fn();
    const status = vi.fn().mockReturnValue({ json });
    new ChatValidationErrorFilter().catch(new BadRequestException('ignored'), {
      switchToHttp: () => ({ getResponse: () => ({ status }) }),
    } as never);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'Chat turn is not valid.',
    });
  });

  it('replaces the reply with a grounded policy answer and its citations', async () => {
    const search = vi.fn();
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        if (String(url).includes('/chat/completions')) {
          return completion(null, [
            toolCall(
              { query: 'What is the fuel policy and a late return?' },
              'call_policy',
              'search_rental_policy',
            ),
          ]);
        }
        if (String(url).endsWith('/rag/query')) {
          return {
            ok: true,
            json: async () => ({
              answer: 'Return it full. A late return costs one extra day.',
              grounded: true,
              citations: [
                { document: 'Fuel policy', chunkId: 'fuel-1', score: 0.82 },
                { document: 'Fuel policy', chunkId: 'fuel-2', score: 0.74 },
                { document: 'Late return', chunkId: 'late-1', score: 0.71 },
              ],
            }),
          };
        }
        throw new Error(`unexpected ${url}`);
      }),
    );

    const result = await new ChatService(
      { search } as unknown as VehiclesService,
      config(),
    ).turn(turn('What is the fuel policy and a late return?'));

    expect(search).not.toHaveBeenCalled();
    expect(llmBodies(calls)).toHaveLength(1);
    const ragCall = calls.find((call) => call.url.endsWith('/rag/query'));
    expect(ragCall?.init?.headers).toEqual({
      'Content-Type': 'application/json',
      'X-Service-Token': 'sentinel-ai-token',
    });
    expect(JSON.parse(String(ragCall?.init?.body))).toEqual({
      query: 'What is the fuel policy and a late return?',
    });
    expect(result.reply).toBe('Return it full. A late return costs one extra day.');
    expect(result.citations).toEqual([
      { document: 'Fuel policy', chunkId: 'fuel-1', score: 0.82 },
      { document: 'Fuel policy', chunkId: 'fuel-2', score: 0.74 },
      { document: 'Late return', chunkId: 'late-1', score: 0.71 },
    ]);
    expect(result.vehicles).toEqual([]);
    expect(result.reservation).toBeNull();
    expect(result.toolTrace).toEqual([
      {
        name: 'search_rental_policy',
        ok: true,
        arguments: { query: 'What is the fuel policy and a late return?' },
      },
    ]);
  });

  it('says the guide does not cover a question when retrieval is not grounded', async () => {
    const search = vi.fn();
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        if (String(url).includes('/chat/completions')) {
          return completion('A chauffeur is available for an extra fee.', [
            toolCall({ query: 'Can I book a chauffeur?' }, 'call_policy', 'search_rental_policy'),
          ]);
        }
        if (String(url).endsWith('/rag/query')) {
          return {
            ok: true,
            json: async () => ({
              answer: 'Vehicles are handed over with a full tank.',
              grounded: false,
              citations: [{ document: 'Fuel policy', chunkId: 'fuel-1', score: 0.2 }],
            }),
          };
        }
        throw new Error(`unexpected ${url}`);
      }),
    );

    const result = await new ChatService(
      { search } as unknown as VehiclesService,
      config(),
    ).turn(turn('Can I book a chauffeur?'));

    expect(search).not.toHaveBeenCalled();
    expect(llmBodies(calls)).toHaveLength(1);
    expect(result.reply).toBe('The guide does not cover that question.');
    expect(result.citations).toEqual([]);
    expect(result.reply).not.toContain('full tank');
    expect(result.reply).not.toContain('chauffeur is available');
  });

  it('keeps a failed policy lookup free of guide text', async () => {
    const search = vi.fn();
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        if (String(url).includes('/chat/completions')) {
          const prior = calls.filter((call) => call.url.includes('/chat/completions')).length;
          if (prior === 1) {
            return completion(null, [
              toolCall({ query: 'What is the fuel policy?' }, 'call_policy', 'search_rental_policy'),
            ]);
          }
          return completion('I could not check the guide.');
        }
        if (String(url).endsWith('/rag/query')) {
          return {
            ok: false,
            status: 502,
            json: async () => ({
              answer: 'Vehicles are handed over with a full tank.',
              citations: [{ document: 'Fuel policy', chunkId: 'fuel-1', score: 0.9 }],
            }),
          };
        }
        throw new Error(`unexpected ${url}`);
      }),
    );

    const result = await new ChatService(
      { search } as unknown as VehiclesService,
      config(),
    ).turn(turn('What is the fuel policy?'));

    expect(search).not.toHaveBeenCalled();
    expect(result.reply).toBe('I could not check the guide.');
    expect(result.citations).toEqual([]);
    expect(result.toolTrace).toEqual([
      expect.objectContaining({ name: 'search_rental_policy', ok: false }),
    ]);
    const toolMessages = (
      llmBodies(calls)[1].messages as { role: string; content: string }[]
    ).filter((message) => message.role === 'tool');
    expect(JSON.parse(toolMessages[0].content)).toEqual({ ok: false });
    expect(toolMessages[0].content).not.toContain('full tank');
    expect(result.reply).not.toContain('full tank');
  });

  it('treats a policy timeout as a failed tool without guide text', async () => {
    const search = vi.fn();
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        if (String(url).includes('/chat/completions')) {
          const prior = calls.filter((call) => call.url.includes('/chat/completions')).length;
          if (prior === 1) {
            return completion(null, [
              toolCall({ query: 'late return fee' }, 'call_policy', 'search_rental_policy'),
            ]);
          }
          return completion('I could not check the guide.');
        }
        if (String(url).endsWith('/rag/query')) {
          throw new Error('timeout');
        }
        throw new Error(`unexpected ${url}`);
      }),
    );

    const result = await new ChatService(
      { search } as unknown as VehiclesService,
      config(),
    ).turn(turn('What is the late fee?'));

    expect(search).not.toHaveBeenCalled();
    expect(result.citations).toEqual([]);
    expect(result.toolTrace).toEqual([
      expect.objectContaining({ name: 'search_rental_policy', ok: false }),
    ]);
    const toolMessages = (
      llmBodies(calls)[1].messages as { role: string; content: string }[]
    ).filter((message) => message.role === 'tool');
    expect(JSON.parse(toolMessages[0].content)).toEqual({ ok: false });
    expect(toolMessages[0].content).not.toContain('endAt');
  });

  it('treats a grounded payload with a bad citation or answer as a failed tool', async () => {
    const guide = 'Vehicles are handed over with a full tank.';
    const payloads = [
      {
        answer: guide,
        grounded: true,
        citations: [{ document: 'Fuel policy', chunkId: 'fuel-1' }],
      },
      {
        answer: { text: guide },
        grounded: true,
        citations: [{ document: 'Fuel policy', chunkId: 'fuel-1', score: 0.9 }],
      },
    ];

    for (const payload of payloads) {
      const search = vi.fn();
      const calls: { url: string; init?: RequestInit }[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          calls.push({ url: String(url), init });
          if (String(url).includes('/chat/completions')) {
            const prior = calls.filter((call) => call.url.includes('/chat/completions')).length;
            if (prior === 1) {
              return completion(null, [
                toolCall({ query: 'What is the fuel policy?' }, 'call_policy', 'search_rental_policy'),
              ]);
            }
            return completion('I could not check the guide.');
          }
          if (String(url).endsWith('/rag/query')) {
            return { ok: true, status: 200, json: async () => payload };
          }
          throw new Error(`unexpected ${url}`);
        }),
      );

      const result = await new ChatService(
        { search } as unknown as VehiclesService,
        config(),
      ).turn(turn('What is the fuel policy?'));

      expect(search).not.toHaveBeenCalled();
      expect(result.reply).toBe('I could not check the guide.');
      expect(result.citations).toEqual([]);
      expect(result.reply).not.toContain('full tank');
      expect(result.toolTrace).toEqual([
        expect.objectContaining({ name: 'search_rental_policy', ok: false }),
      ]);
      const toolMessages = (
        llmBodies(calls)[1].messages as { role: string; content: string }[]
      ).filter((message) => message.role === 'tool');
      expect(JSON.parse(toolMessages[0].content)).toEqual({ ok: false });
      expect(toolMessages[0].content).not.toContain('full tank');
      vi.unstubAllGlobals();
    }
  });
});

describe('ChatController', () => {
  it('passes the JWT user id into the chat turn', async () => {
    const turnFn = vi.fn().mockResolvedValue({ reply: 'ok' });
    const controller = new ChatController({ turn: turnFn } as unknown as ChatService);
    const dto = turn('Reserve it for tomorrow.');
    await controller.turn({ user: { id: 'priya-user' } } as never, dto);
    expect(turnFn).toHaveBeenCalledWith(dto, 'priya-user');
  });

  it('applies the chat validation filter', () => {
    const filters = Reflect.getMetadata(
      EXCEPTION_FILTERS_METADATA,
      ChatController,
    ) as unknown[];
    expect(filters).toEqual(expect.arrayContaining([ChatValidationErrorFilter]));
  });
});
