// main.ts — the entrypoint the suite runs as `node /bot/main.ts` (Node 22).
//
// Lifecycle (see the kit's RULES.txt and starter/main.ts):
//   1. Bind an ephemeral port (listen(0)) — never 8080, the env listens there.
//   2. POST {"port": N} to $MAKEFUN_ENV_URL/register; the env records the
//      address the request came from and dials it.
//   3. Long-poll GET $MAKEFUN_ENV_URL/done until {"done": true}, then exit 0.
//      A crash, a timeout or an unregistered exit scores 0, so the server
//      stays up and keeps answering until the env says the trial is over.
//
// Without MAKEFUN_ENV_URL (local development) the server still starts and
// prints its port, so it can be driven directly.
import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function register(port: number): Promise<void> {
  const url = `${ENV_URL}/register`;
  const deadline = Date.now() + 30_000;
  let delay = 200;
  for (;;) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ port }),
          signal: controller.signal,
        });
        if (response.ok) return;
        process.stderr.write(`[entry] register answered HTTP ${response.status}, retrying\n`);
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[entry] register failed: ${message}, retrying\n`);
    }
    if (Date.now() > deadline) throw new Error('could not register with the env');
    await sleep(delay);
    delay = Math.min(delay * 2, 2_000);
  }
}

async function waitDone(): Promise<void> {
  const url = `${ENV_URL}/done`;
  for (;;) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (response.ok) {
          const body = (await response.json()) as { done?: boolean };
          if (body.done === true) return;
        }
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // The env may restart; keep polling.
    }
    await sleep(1_000);
  }
}

async function main(): Promise<number> {
  const { listen } = createApp({ token: TOKEN });
  const port = await listen(0);
  process.stderr.write(`[entry] forge listening on 127.0.0.1:${port}\n`);
  if (ENV_URL === '') {
    process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: running standalone (Ctrl-C to stop)\n');
    await new Promise<void>((resolve) => {
      process.on('SIGINT', () => resolve());
      process.on('SIGTERM', () => resolve());
    });
    return 0;
  }
  await register(port);
  process.stderr.write('[entry] registered with the env\n');
  await waitDone();
  process.stderr.write('[entry] trial done, exiting 0\n');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[entry] fatal: ${message}\n`);
    process.exit(1);
  });
