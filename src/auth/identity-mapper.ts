/**
 * Adapted directly from Watt commit 476e3cd
 * packages/gateway/src/authz/identity-mapper.ts.
 * Roles are resolved from D1 at decision/effect time rather than snapshotted as authority.
 */

const PRINCIPAL_PATTERN = /^(?:user|service|agent):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CHANNEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const CHANNEL_USER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
const ROLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

interface IdentityRow {
  roles: string;
}

interface ChannelIdentityRow {
  principal: string;
}

export interface ResolvedPrincipal {
  roles: string[];
}

export interface ResolvedIdentity {
  principal: string;
  roles: string[];
}

export const ANONYMOUS_PRINCIPAL = 'user:anonymous';

export class IdentityMapper {
  constructor(private readonly db: D1Database) {}

  async resolvePrincipal(principal: string): Promise<ResolvedPrincipal> {
    if (!PRINCIPAL_PATTERN.test(principal)) return { roles: [] };
    const row = await this.db.prepare(
      'SELECT roles FROM identity_mappings WHERE principal = ?',
    ).bind(principal).first<IdentityRow>();
    if (row === null) return { roles: [] };
    let roles: unknown;
    try {
      roles = JSON.parse(row.roles) as unknown;
    } catch {
      throw new Error('identity roles are invalid');
    }
    if (
      !Array.isArray(roles) || roles.length > 100 ||
      !roles.every((role) => typeof role === 'string' && ROLE_PATTERN.test(role)) ||
      new Set(roles).size !== roles.length
    ) throw new Error('identity roles are invalid');
    return { roles: [...roles].sort() };
  }

  async resolve(channel: string, channelUserId: string): Promise<ResolvedIdentity> {
    if (!CHANNEL_PATTERN.test(channel) || !CHANNEL_USER_PATTERN.test(channelUserId)) {
      return { principal: ANONYMOUS_PRINCIPAL, roles: [] };
    }
    const row = await this.db.prepare(
      'SELECT principal FROM channel_identities WHERE channel = ? AND channel_user_id = ?',
    ).bind(channel, channelUserId).first<ChannelIdentityRow>();
    if (row === null || !PRINCIPAL_PATTERN.test(row.principal)) {
      return { principal: ANONYMOUS_PRINCIPAL, roles: [] };
    }
    const resolved = await this.resolvePrincipal(row.principal);
    return { principal: row.principal, roles: resolved.roles };
  }

  async bindChannelIdentity(
    channel: string,
    channelUserId: string,
    principal: string,
    now = new Date().toISOString(),
  ): Promise<void> {
    if (
      !CHANNEL_PATTERN.test(channel) || !CHANNEL_USER_PATTERN.test(channelUserId) ||
      !PRINCIPAL_PATTERN.test(principal) || !Number.isFinite(Date.parse(now))
    ) throw new Error('channel identity binding is invalid');
    const existing = await this.db.prepare(
      'SELECT principal FROM channel_identities WHERE channel = ? AND channel_user_id = ?',
    ).bind(channel, channelUserId).first<ChannelIdentityRow>();
    if (existing?.principal === principal) return;
    await this.db.prepare(
      `INSERT INTO channel_identities (
         channel, channel_user_id, principal, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(channel, channel_user_id) DO UPDATE SET
         principal = excluded.principal, updated_at = excluded.updated_at`,
    ).bind(channel, channelUserId, principal, now, now).run();
  }

  async bind(
    principal: string,
    roles: string[],
    now = new Date().toISOString(),
  ): Promise<void> {
    if (
      !PRINCIPAL_PATTERN.test(principal) || roles.length > 100 ||
      !roles.every((role) => ROLE_PATTERN.test(role)) ||
      new Set(roles).size !== roles.length || !Number.isFinite(Date.parse(now))
    ) throw new Error('principal identity binding is invalid');
    const normalizedRoles = [...roles].sort();
    const existing = await this.db.prepare(
      'SELECT roles FROM identity_mappings WHERE principal = ?',
    ).bind(principal).first<IdentityRow>();
    if (existing !== null) {
      let existingRoles: unknown;
      try {
        existingRoles = JSON.parse(existing.roles) as unknown;
      } catch {
        throw new Error('identity roles are invalid');
      }
      if (
        !Array.isArray(existingRoles) || existingRoles.length > 100 ||
        !existingRoles.every((role) => typeof role === 'string' && ROLE_PATTERN.test(role)) ||
        new Set(existingRoles).size !== existingRoles.length
      ) throw new Error('identity roles are invalid');
      if (JSON.stringify([...existingRoles].sort()) === JSON.stringify(normalizedRoles)) return;
    }
    await this.db.prepare(
      `INSERT INTO identity_mappings (principal, roles, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(principal) DO UPDATE SET roles = excluded.roles, updated_at = excluded.updated_at`,
    ).bind(principal, JSON.stringify(normalizedRoles), now, now).run();
  }
}
