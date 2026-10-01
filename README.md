# RideNear API

NestJS API for DRN(DiscoverRideNear). This README is the canonical Section 6 demo script. The web and AI READMEs link here and do not repeat these steps.

Sample vehicles are fictional Bengaluru listings. GPS motion is simulated. Payments are not collected.

The site is not deployed yet. Host class, placeholder login and health URLs, migrate, and the one-time seed are in [docs/deployment.md](docs/deployment.md).

## Demo account

Chat steps require the model `gpt-4o-mini`.

| Field | Value |
| --- | --- |
| Name | Priya Sharma |
| Email | `priya@ridenear.demo` |
| Password | `DRN(DiscoverRideNear)#2026` |

“Tomorrow” means the next calendar date in Asia/Kolkata, from 10:00 to 10:00 the following day (one rental day). The map default pin is MG Road, `12.9756, 77.6068`.

## Pre-demo health

`GET /api/health` is the pre-demo check. The body includes `api`, `database`, and `aiService`. The AI service counts as `up` only when its own `GET /health` body has `status: ok`.

Start Section 6 only when `aiService` is `up`. Do not start while `aiService` is `down`.

## Section 6

| Step | User action | Expected result |
| --- | --- | --- |
| D1 | Log in as Priya Sharma | Home opens with chat and a map centered on MG Road (`12.9756, 77.6068`) |
| D2 | Send: “Find me an automatic SUV near me for tomorrow under INR 3,000 per day.” | Reply lists only automatic SUVs, price ≤ 3000, available tomorrow, each with distance |
| D3 | Send: “Tell me more about the closest one.” | Reply uses that vehicle’s stored make, model, seats, fuel, deposit, and price |
| D4 | Send: “Is it free tomorrow?” | Reply states available or names the conflicting reservation |
| D5 | Send: “What will it cost for tomorrow?” | Total equals `ceil(days) × pricePerDay` for that vehicle |
| D6 | Send: “Reserve it for tomorrow.” | Reply includes a reservation id and status `confirmed` |
| D7 | Send again: “Reserve it for tomorrow.” | The same confirmed reservation id is returned. A second reservation row is not created. A different overlapping range is not this repeat and returns HTTP 409 |
| D8 | Send: “What is your fuel policy and what happens if I return it late?” | Answer quotes the fuel policy and the late-return policy from the rental guide |
| D9 | Choose **Track on map** on the reservation confirmation or on My trips | The marker is at the vehicle’s current coordinates. The popup shows the vehicle name and reservation id |
| D10 | Leave the page open and wait about 10 seconds. Do not refresh | The marker moves at least three times. The default tick is 2 seconds |

## Environment

Copy `.env.example` to `.env`. Set values locally. Do not commit `.env`.

| Variable | Role |
| --- | --- |
| `DATABASE_URL` | Postgres connection string |
| `JWT_SECRET` | Signing secret for login tokens |
| `AI_SERVICE_URL` | AI service origin (no `/api` prefix) |
| `AI_SERVICE_TOKEN` | Shared token sent to the AI service |
| `LLM_BASE_URL` | OpenAI-compatible API origin |
| `LLM_API_KEY` | Key for chat. Leave empty only if you are not running D2–D8 |
| `LLM_MODEL` | Must be `gpt-4o-mini` for the chat steps |
| `CORS_ORIGIN` | Web origin allowed to call the API |
| `GPS_TICK_MS` | Simulated GPS interval in milliseconds (default `2000`) |
| `PORT` | API listen port (default `3000`) |

## Local run

1. Copy `.env.example` to `.env`. Set `AI_SERVICE_URL` to `http://localhost:8000`. Set `LLM_API_KEY` if you will run the chat steps.
2. Start the AI service first. Follow [../ridenear-ai/README.md](../ridenear-ai/README.md).
3. Start Postgres: `docker compose up -d postgres` from this directory.
4. `npm install`
5. `npx prisma migrate deploy`
6. Seed **once**: `npx prisma db seed`
7. `npm run start:dev`

Swagger: http://localhost:3000/api/docs

`docker compose up --build` from this directory is local only. If the database has no demo user, run the one-time seed. It builds web, API, AI, and Postgres from the sibling folders. `docker-compose.yml` stays in `ridenear-api`. GPS runs inside the API process.

The API container start command runs `npx prisma migrate deploy` and then starts Node. It does not seed.

## Seed warning

`npx prisma db seed` deletes every reservation, vehicle, and user, then creates Priya Sharma and the sample vehicles. That wipe includes existing bookings. Run it once for a fresh demo database. Do not run it on every boot, and do not add it to the API container start command. Running it again wipes bookings.
