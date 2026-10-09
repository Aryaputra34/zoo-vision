// Fails when the committed generated output is stale: regenerates, then rejects any modified or
// untracked file under the generated directories. Run it after `git add` locally.
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const paths = ['generated', '../../services/engine/contracts'];
const git = (...args) => execFileSync('git', [...args], { cwd: pkgRoot, encoding: 'utf8' });

execFileSync(process.execPath, [join(pkgRoot, 'scripts', 'generate.mjs')], { cwd: pkgRoot, stdio: 'inherit' });

const diff = spawnSync('git', ['diff', '--exit-code', '--', ...paths], { cwd: pkgRoot, stdio: 'inherit' });
const untracked = git('status', '--porcelain', '--', ...paths).trim();
if (diff.status !== 0 || untracked) {
  if (untracked) console.error(`Generated files differ from the committed ones:\n${untracked}`);
  console.error('Run `npm run generate` and commit the result.');
  process.exit(1);
}
console.log('generated output is up to date');
