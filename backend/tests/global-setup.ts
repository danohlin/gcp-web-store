import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

/**
 * Brings the dedicated test database up to the current migration state once per
 * run. `migrate deploy` is the same command CI and the Helm migration job use,
 * so tests exercise the real migration path rather than `db push`.
 */
export default function setup(): void {
  // Resolve the CLI's JS entry point and run it under the current Node binary.
  // Spawning `npx`/`npx.cmd` instead would need a shell on Windows, which is
  // both a quoting hazard and an EINVAL on spawnSync.
  const prismaPkg = require.resolve('prisma/package.json');
  const cli = path.join(path.dirname(prismaPkg), 'build', 'index.js');

  execFileSync(process.execPath, [cli, 'migrate', 'deploy'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      DATABASE_URL: 'postgresql://webstore:webstore@localhost:5432/webstore_test?schema=public',
    },
  });
}
