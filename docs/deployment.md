# Deployment notes

Hosting is not done yet. This story does not create a cloud service, a database, or a public site. The URLs below are placeholders, not live addresses.

## Hosts

| Part | Host class |
| --- | --- |
| Web | A static host |
| API | A Render, Railway, or Fly-class host |
| AI service | A Render, Railway, or Fly-class host, with a disk for `CHROMA_PATH` |
| Database | Hosted Postgres |

`docker-compose.yml` stays only in `ridenear-api` and is for local use. GPS stays in the API process. Do not run it as a separate worker. Commit `.env.example` only. Do not commit `.env` files, API keys, or database passwords. Logs are process stdout. Secrets stay in environment variables.

## URLs

The public site is not deployed.

| Check | Placeholder |
| --- | --- |
| Login | `{WEB_ORIGIN}/login` |
| Health | `{API_ORIGIN}/api/health` |

When those origins are filled in later, login is the web origin plus `/login`. Do not treat either line as a live URL.

## When hosting later

Set the web build `VITE_API_URL` and `VITE_WS_URL` to the API origin, `CORS_ORIGIN` on the API to the web origin, and `AI_SERVICE_URL` on the API to the AI origin. Login stays `{WEB_ORIGIN}/login` and health stays `{API_ORIGIN}/api/health`.

## Health before the demo

`GET /api/health` is the pre-demo check. Start Section 6 only when the body has `aiService: "up"`. Do not start the demo while `aiService` is `down`. `up` means the AI service `GET /health` body has `status: ok`.

The demo script is in [../README.md](../README.md). Chat steps require `gpt-4o-mini`. The demo account is Priya Sharma, `priya@ridenear.demo`, password `DRN(DiscoverRideNear)#2026`.

## Release

On each API release, run Prisma migrate, then start the process. The API image already does that: `npx prisma migrate deploy`, then Node. Do not add seed to that start command.

Seed is a separate one-time command after migrate:

```bash
npx prisma db seed
```

Seed deletes users, vehicles, and reservations, then creates Priya and the sample vehicles. That deletes existing bookings. Run it once on a new database. Do not run it on every boot. Running it again wipes bookings.
