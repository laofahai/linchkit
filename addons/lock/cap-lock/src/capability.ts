/**
 * cap-lock capability definition (static, default-config form).
 *
 * Advanced field-lock policy layered on core's Phase 1 enforcement (Spec 63
 * §4.2): shadow mode, bypass groups, tolerance period, and an audit trail —
 * exposed through a single `field-lock-check` interceptor.
 *
 * This static definition uses default config (shadow off, no bypass groups,
 * no tolerance), which is a no-op over core. To customize policy or inject a
 * logger, use {@link createCapLock} from `./factory` instead.
 */

import { createCapLock } from "./factory";

export const capLock = createCapLock();
