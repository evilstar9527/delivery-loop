import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  OUTBOX_DEAD_LETTER_QUEUE,
  OUTBOX_DEAD_LETTER_QUARANTINE_QUEUE,
  PRIMARY_OUTBOX_QUEUE,
} from '../src/outbox/outbox-dead-letter.js';

interface WranglerQueueConsumer {
  queue: string;
  max_batch_size?: number;
  max_batch_timeout?: number;
  max_retries?: number;
  dead_letter_queue?: string;
  retry_delay?: number;
}

describe('Cloudflare Queue dead-letter configuration', () => {
  it('moves the primary queue to a consumed durable DLQ after three retries', () => {
    const config = JSON.parse(
      readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'),
    ) as { queues: { consumers: WranglerQueueConsumer[] } };
    expect(config.queues.consumers).toContainEqual({
      queue: PRIMARY_OUTBOX_QUEUE,
      max_batch_size: 10,
      max_batch_timeout: 5,
      max_retries: 3,
      dead_letter_queue: OUTBOX_DEAD_LETTER_QUEUE,
    });
    expect(config.queues.consumers).toContainEqual({
      queue: OUTBOX_DEAD_LETTER_QUEUE,
      max_batch_size: 10,
      max_batch_timeout: 5,
      max_retries: 100,
      retry_delay: 60,
      dead_letter_queue: OUTBOX_DEAD_LETTER_QUARANTINE_QUEUE,
    });
  });
});
