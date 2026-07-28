/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ANONYMOUS_PRINCIPAL,
  IdentityMapper,
} from '../../src/auth/identity-mapper.js';

const NOW = '2026-07-26T03:00:00.000Z';

beforeEach(async () => {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM channel_identities'),
    env.DB_CONTROL.prepare('DELETE FROM identity_mappings'),
  ]);
});

describe('Watt-derived identity mapper', () => {
  it('fails closed for unmapped subjects and isolates the same id by channel', async () => {
    const mapper = new IdentityMapper(env.DB_CONTROL);
    expect(await mapper.resolve('feishu:tenant-a', 'same-user')).toEqual({
      principal: ANONYMOUS_PRINCIPAL,
      roles: [],
    });
    await mapper.bind('user:feishu-reviewer', ['human'], NOW);
    await mapper.bind('user:github-reviewer', ['approve:merge', 'human'], NOW);
    await mapper.bindChannelIdentity(
      'feishu:tenant-a',
      'same-user',
      'user:feishu-reviewer',
      NOW,
    );
    await mapper.bindChannelIdentity(
      'github:example/repository',
      'same-user',
      'user:github-reviewer',
      NOW,
    );
    expect(await mapper.resolve('feishu:tenant-a', 'same-user')).toEqual({
      principal: 'user:feishu-reviewer',
      roles: ['human'],
    });
    expect(await mapper.resolve('github:example/repository', 'same-user')).toEqual({
      principal: 'user:github-reviewer',
      roles: ['approve:merge', 'human'],
    });
  });

  it('upserts a channel mapping and resolves roles live after revocation', async () => {
    const mapper = new IdentityMapper(env.DB_CONTROL);
    await mapper.bind('user:first', ['approve:merge', 'human'], NOW);
    await mapper.bind('user:second', ['human'], NOW);
    await mapper.bindChannelIdentity('feishu:tenant-a', 'ou_reviewer', 'user:first', NOW);
    expect(await mapper.resolve('feishu:tenant-a', 'ou_reviewer')).toEqual({
      principal: 'user:first',
      roles: ['approve:merge', 'human'],
    });
    await mapper.bind('user:first', ['human'], '2026-07-26T03:00:01.000Z');
    expect(await mapper.resolve('feishu:tenant-a', 'ou_reviewer')).toEqual({
      principal: 'user:first',
      roles: ['human'],
    });
    await mapper.bindChannelIdentity(
      'feishu:tenant-a',
      'ou_reviewer',
      'user:second',
      '2026-07-26T03:00:02.000Z',
    );
    expect(await mapper.resolve('feishu:tenant-a', 'ou_reviewer')).toEqual({
      principal: 'user:second',
      roles: ['human'],
    });
  });
});
