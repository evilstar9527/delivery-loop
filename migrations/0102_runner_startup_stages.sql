-- Durable, control-plane-side breadcrumb of how far a runner got through its
-- pre-heartbeat startup chain, so an intermittent analysis freeze can finally be
-- located.
--
-- The analysis runner's stdout/stderr is NOT captured by the Cloudflare Sandbox
-- /logs endpoint (proven empirically: a healthy analysis run that provably beat
-- its heartbeat still produced zero captured log bytes). Every stderr-based
-- breadcrumb is therefore invisible for analysis, and a frozen attempt shows an
-- empty log. Code review could not pin the hang — every awaited control-plane
-- call is timeout-bounded and would throw rather than hang — yet a post-checkout
-- freeze persists (one attempt reached a single model reservation, then its
-- heartbeat never advanced for minutes).
--
-- The runner posts one row here as it crosses each pre-launch stage. The POST is
-- fire-and-forget, outside the runner's request lock, and bounded by its own
-- short timeout, so this channel can neither be blocked by the freeze it is
-- diagnosing nor introduce a new hang. The LAST row for a frozen attempt names
-- the stage immediately before the await that hung.
--
-- Rows hold only an attempt id, a fixed stage enum and a timestamp. No task
-- bodies, tokens or provider payloads.

CREATE TABLE IF NOT EXISTS runner_startup_stages (
  id           TEXT PRIMARY KEY,
  attempt_id   TEXT NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  stage        TEXT NOT NULL CHECK (stage IN (
    'exchanged',
    'checked_out',
    'snapshotted',
    'context_loaded',
    'workspace_prepared',
    'reserving_model',
    'reserved_model',
    'launching_heartbeat'
  )),
  recorded_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runner_startup_stages_attempt
  ON runner_startup_stages(attempt_id, recorded_at);
