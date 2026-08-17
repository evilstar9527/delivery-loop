/**
 * Compatibility names for the grant-backed authorization boundary.
 * Callback-authenticated reservation lookup was intentionally removed: every
 * model request must now present the per-reservation bearer grant.
 */
export {
  ExecutorModelGrantError as ExecutorModelAuthorizationError,
  ExecutorModelGrantStore as ExecutorModelAuthorizationStore,
} from './executor-model-grant-store.js';
export type {
  ExecutorModelGrantAuthorization as ExecutorModelAuthorization,
} from './executor-model-grant-store.js';
