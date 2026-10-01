import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(apiRoot, '..');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('demo notes', () => {
  const apiReadme = read(resolve(apiRoot, 'README.md'));
  const webReadme = read(resolve(workspaceRoot, 'ridenear-web/README.md'));
  const aiReadme = read(resolve(workspaceRoot, 'ridenear-ai/README.md'));
  const deployment = read(resolve(apiRoot, 'docs/deployment.md'));

  it('says hosting is not done and the future login path is /login', () => {
    expect(deployment).toContain('Hosting is not done yet');
    expect(deployment).toContain('{WEB_ORIGIN}/login');
    expect(deployment).not.toMatch(
      /https?:\/\/(?!\{WEB_ORIGIN\}|\{API_ORIGIN\})[a-z0-9.-]+\.[a-z]{2,}/i,
    );
    expect(apiReadme).toContain('The site is not deployed yet');
  });

  it('requires aiService up before Section 6', () => {
    expect(deployment).toContain('aiService: "up"');
    expect(deployment).toContain('Do not start the demo while `aiService` is `down`');
    expect(apiReadme).toContain('Do not start while `aiService` is `down`');
    expect(aiReadme).toContain('Do not start Section 6 while the API reports `aiService` as `down`');
  });

  it('describes migrate, then a one-time seed that wipes bookings', () => {
    expect(deployment).toContain('npx prisma migrate deploy');
    expect(deployment).toContain('npx prisma db seed');
    expect(deployment).toContain('wipes bookings');
    expect(deployment).toContain('Do not add seed to that start command');
    expect(apiReadme).toContain('deletes every reservation, vehicle, and user');
  });

  it('lists Section 6 in the API README and names the demo account and model', () => {
    for (const step of ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10']) {
      expect(apiReadme).toContain(`| ${step} |`);
      expect(webReadme).not.toContain(`| ${step} |`);
      expect(aiReadme).not.toContain(`| ${step} |`);
    }
    expect(apiReadme).toContain('priya@ridenear.demo');
    expect(apiReadme).toContain('gpt-4o-mini');
    expect(webReadme).toContain('../ridenear-api/README.md');
    expect(aiReadme).toContain('../ridenear-api/README.md');
    expect(webReadme).toContain('VITE_API_URL');
    expect(webReadme).toContain('VITE_WS_URL');
    expect(aiReadme).not.toContain('later stories');
  });
});
