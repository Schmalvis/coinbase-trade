import fs from 'fs';
import os from 'os';
import path from 'path';

// Nit4: several test files import (directly or transitively, e.g. via executor.ts, engine.ts,
// server.ts) '../src/data/db.ts', which connects to a real on-disk SQLite file at
// `config.DATA_DIR` as a MODULE-LEVEL side effect on import (see src/data/connection.ts:
// `new Database(path.join(config.DATA_DIR, 'trades.db'))`). Any test file that doesn't
// explicitly vi.mock('../src/config.js') or '../src/data/db.js' would otherwise open the REAL
// dev/bot database (default DATA_DIR: /home/pi/.local/share/coinbase-trade/base-sepolia) and
// write real rows into it — this has already happened (e.g. tests/db-grid-state.test.ts).
//
// Fix at the root: set DATA_DIR to a fresh, unique, ephemeral directory under os.tmpdir()
// before any test file's own imports run. Vitest runs `setupFiles` before loading each test
// file's module graph, so this executes ahead of any transitive `db.js` import in every test
// file — regardless of whether that file mocks config/db itself. Per-file config mocks (e.g.
// `vi.mock('../src/config.js', () => ({ config: { DATA_DIR: '/tmp/test', ... } }))`) simply
// override this env var's effect for that file and are unaffected.
//
// This never touches or deletes the real DATA_DIR — it only ensures unmocked test files land
// on a throwaway directory instead.
const ephemeralDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coinbase-trade-test-'));
process.env.DATA_DIR = ephemeralDataDir;
