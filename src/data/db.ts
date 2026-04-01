// DB connection — import this to get the shared Database instance.
// Schema is initialised as a side-effect when schema.js is imported — migrations
// run before any query module evaluates its db.prepare() calls.
export { db } from './connection.js';
import './schema.js';

export { queries, runTransaction, portfolioSnapshotQueries } from './queries/core.js';
export { settingQueries } from './queries/settings.js';
export { discoveredAssetQueries, type DiscoveredAssetRow } from './queries/assets.js';
export { candleQueries, type CandleRow } from './queries/candles.js';
export { rotationQueries, dailyPnlQueries, type RotationRow, type DailyPnlRow } from './queries/rotations.js';
export { watchlistQueries, type WatchlistRow } from './queries/watchlist.js';
export { passkeyQueries, type PasskeyRow } from './queries/passkeys.js';
export { gridStateQueries, type GridStateRow } from './queries/grid.js';
