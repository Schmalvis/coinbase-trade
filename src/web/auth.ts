// Re-exports for backward compatibility — split into focused modules
export {
  createAuthMiddleware,
  createSessionMiddleware,
  isIpAllowed,
  checkRateLimit,
  resetRateLimit,
  clearRateLimits,
  requireAuth,
} from './middleware.js';
export { registerTotpRoutes } from './auth-routes.js';
export { registerWebAuthnRoutes } from './webauthn.js';

// Backward compat: registerAuthRoutes wraps both
import { Router } from 'express';
import { registerTotpRoutes } from './auth-routes.js';
import { registerWebAuthnRoutes } from './webauthn.js';

interface SettingQueries {
  getSetting: { get: (key: string) => { value: string } | undefined };
  upsertSetting: { run: (key: string, value: string) => void };
}

interface PasskeyQueries {
  insertPasskey: { run: (params: { id: string; public_key: string; counter: number; transports: string | null; label: string }) => void };
  getPasskeyById: { get: (id: string) => { id: string; public_key: string; counter: number; transports: string | null; created_at: string; label: string } | undefined };
  getAllPasskeys: { all: () => Array<{ id: string; public_key: string; counter: number; transports: string | null; created_at: string; label: string }> };
  updatePasskeyCounter: { run: (counter: number, id: string) => void };
  deletePasskey: { run: (id: string) => void };
}

interface WebAuthnConfig {
  rpId: string;
  rpName: string;
  origin: string;
}

export function registerAuthRoutes(
  app: { use: (path: string, router: Router) => void },
  settingQueries: SettingQueries,
  sessionSecret: string,
  passkeyQueriesParam?: PasskeyQueries,
  webauthnConfig?: WebAuthnConfig,
): void {
  const router = Router();
  registerTotpRoutes(router, settingQueries, sessionSecret);
  if (passkeyQueriesParam && webauthnConfig) {
    registerWebAuthnRoutes(router, settingQueries, passkeyQueriesParam, webauthnConfig);
  }
  app.use('/auth', router);
}
