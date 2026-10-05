import { Hono } from 'hono';
import OpenAI from 'openai';
import type { Env } from '../types';
import { buildOAIMessages } from '../lib/prompts';
import type { DogProfile, Message } from '../lib/prompts';

const app = new Hono<{ Bindings: Env }>();

interface GenerateBody {
  trigger: string | number;
  dogProfile: DogProfile;
  messages: Message[];
  /** Optional base64 JPEG frames (phone live video), oldest first, max 3 */
  images?: string[];
}

/**
 * POST /v1/generate
 *
 * Returns a server-sent events (SSE) stream of dog responses.
 * Each event is: data: {"type":"token","text":"..."}\n\n
 * Final event:   data: {"type":"done","full_text":"..."}\n\n
 * Terminator:    data: [DONE]\n\n
 */
app.post('/', async (c) => {
  const body = await c.req.json<GenerateBody>();
  const { trigger, dogProfile, messages } = body;
  const images = (body.images ?? []).slice(0, 3);

  if (!dogProfile || trigger === undefined) {
    return c.json({ error: 'dogProfile and trigger are required' }, 400);
  }
  if (images.some(i => typeof i !== 'string' || i.length > 600_000)) {
    return c.json({ error: 'images must be base64 JPEG under ~450 kB each' }, 413);
  }

  const oai = new OpenAI({ apiKey: c.env.OPENAI_API_KEY });
  const oaiMessages = buildOAIMessages(dogProfile, trigger, messages ?? [], images);
  if (images.length) console.log('[generate] with', images.length, 'image(s)');

  // Use a TransformStream to pipe OpenAI SSE through to the client.
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();

  const writeEvent = (payload: unknown) =>
    writer.write(enc.encode(`data: ${JSON.stringify(payload)}\n\n`));

  // Run async generation in the background while we return the stream header.
  const streamingWork = (async () => {
    let fullText = '';
    try {
      const model = c.env.MODEL_NAME ?? 'gpt-6-luna';
      console.log('[generate] starting stream — model:', model, 'trigger:', trigger);

      // A talking dog doesn't need to think: turn reasoning off (gpt-6 'none',
      // gpt-5 'minimal') unless REASONING_EFFORT overrides it. (Cast: the
      // pinned SDK's types predate these effort / verbosity values.)
      const effort =
        c.env.REASONING_EFFORT ??
        (/^gpt-6/.test(model) ? 'none' : /^gpt-5/.test(model) ? 'minimal' : undefined);
      const params = {
        model,
        input: oaiMessages,
        stream: true as const,
        max_output_tokens: 160,
        ...(effort ? { reasoning: { effort }, text: { verbosity: 'low' } } : {}),
      } as unknown as Parameters<typeof oai.responses.create>[0] & { stream: true };
      const stream = await oai.responses.create(params);

      for await (const event of stream) {
        console.log('[generate] event type:', event.type);
        if (event.type === 'response.output_text.delta') {
          const token = event.delta;
          fullText += token;
          await writeEvent({ type: 'token', text: token });
        } else if (event.type === 'response.completed') {
          break;
        }
      }

      console.log('[generate] done — fullText length:', fullText.length);
      await writeEvent({ type: 'done', full_text: fullText });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[generate] error:', msg);
      await writeEvent({ type: 'error', message: msg });
    } finally {
      await writer.write(enc.encode('data: [DONE]\n\n'));
      await writer.close();
    }
  })();

  // Attach the streaming work to the execution context so it isn't cancelled
  // when the Response headers are flushed.
  c.executionCtx.waitUntil(streamingWork);

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
});

export default app;
