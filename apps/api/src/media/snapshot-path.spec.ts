import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSnapshot } from './snapshot-path';

describe('resolveSnapshot', () => {
  let base: string;
  let root: string;

  beforeAll(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'zoo-snap-')));
    root = join(base, 'snapshots');
    await mkdir(join(root, 'cam1', '2026-10-14'), { recursive: true });
    await mkdir(join(base, 'outside'), { recursive: true });
    await writeFile(join(root, 'cam1', '2026-10-14', 'evt_1.jpg'), 'jpeg');
    await writeFile(join(root, 'cam1', 'note.txt'), 'text');
    await writeFile(join(base, 'x.jpg'), 'above the root');
    await writeFile(
      join(base, 'snapshots-evil.jpg'),
      'a sibling sharing the prefix',
    );
    await writeFile(join(base, 'outside', 'secret.jpg'), 'secret');
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('returns the real path of a .jpg inside the root', async () => {
    expect(await resolveSnapshot(root, 'cam1/2026-10-14/evt_1.jpg')).toBe(
      join(root, 'cam1', '2026-10-14', 'evt_1.jpg'),
    );
  });

  it.each([
    '../x.jpg',
    '/etc/passwd',
    'a/../../x.jpg',
    'cam1/../../x.jpg',
    'cam1/2026-10-14/../../../x.jpg',
    'cam1/../cam1/2026-10-14/evt_1.jpg', // a `..` that lands back inside is refused too
    'a\\..\\x.jpg',
    'cam1\\2026-10-14\\evt_1.jpg',
    'a\u0000.jpg',
    'cam1/2026-10-14/evt_1.jpg\u0000.png',
    '',
    '.',
    'C:/Windows/win.ini',
    'cam1/2026-10-14/evt_1.jpg:stream',
    '../snapshots-evil.jpg',
  ])('refuses %j', async (rel) => {
    expect(await resolveSnapshot(root, rel)).toBeNull();
  });

  it('refuses a folder, a missing file and a file that is not a .jpg', async () => {
    expect(await resolveSnapshot(root, 'cam1/2026-10-14')).toBeNull();
    expect(await resolveSnapshot(root, 'cam1/2026-10-14/none.jpg')).toBeNull();
    expect(await resolveSnapshot(root, 'cam1/note.txt')).toBeNull();
  });

  it('refuses a symlink inside the folder that points outside it', async () => {
    // a junction needs no privilege on Windows; on Linux it is an ordinary symlink
    await symlink(join(base, 'outside'), join(root, 'cam1', 'out'), 'junction');
    expect(await resolveSnapshot(root, 'cam1/out/secret.jpg')).toBeNull();
  });

  it('refuses a file symlink that points outside (where the OS lets the test make one)', async () => {
    const link = join(root, 'cam1', 'link.jpg');
    try {
      await symlink(join(base, 'outside', 'secret.jpg'), link, 'file');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return; // Windows without privilege
      throw err;
    }
    expect(await resolveSnapshot(root, 'cam1/link.jpg')).toBeNull();
  });

  it('follows a symlink that stays inside the root', async () => {
    await symlink(
      join(root, 'cam1', '2026-10-14'),
      join(root, 'latest'),
      'junction',
    );
    expect(await resolveSnapshot(root, 'latest/evt_1.jpg')).toBe(
      join(root, 'cam1', '2026-10-14', 'evt_1.jpg'),
    );
  });

  it('works when the root itself is reached through a symlink', async () => {
    const alias = join(base, 'alias');
    await symlink(root, alias, 'junction');
    expect(await resolveSnapshot(alias, 'cam1/2026-10-14/evt_1.jpg')).toBe(
      join(root, 'cam1', '2026-10-14', 'evt_1.jpg'),
    );
  });

  it('a root that does not exist serves nothing', async () => {
    expect(
      await resolveSnapshot(join(base, 'missing'), 'cam1/2026-10-14/evt_1.jpg'),
    ).toBeNull();
  });
});
