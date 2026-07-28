import type { Bindings } from './env.js';

declare global {
  namespace Cloudflare {
    // Declaration merging requires an interface even though Bindings is complete.
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Env extends Bindings {}
  }
}
