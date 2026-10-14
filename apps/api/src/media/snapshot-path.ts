import { realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, sep } from 'node:path';

/** Characters no snapshot path has (the engine writes `[A-Za-z0-9_-]` names): NUL, backslash, colon. */
const FORBIDDEN = /[\0\\:]/;

/**
 * Maps the relative path of a snapshot to the real file under `root`, or null for anything that
 * is not a `.jpg` file inside it. The path comes from the request URL, so it is untrusted:
 *
 * - refused by its text: absolute, containing NUL, a backslash or a colon, or an empty, `.` or
 *   `..` segment, even a `..` that would normalise back inside;
 * - refused by where it lands: the real path (symbolic links resolved) must be inside the real
 *   root, so a link in the folder can not lead out of it.
 *
 * The caller opens the returned path and streams that handle, so what was checked is what is read.
 */
export async function resolveSnapshot(
  root: string,
  rel: string,
): Promise<string | null> {
  if (FORBIDDEN.test(rel) || isAbsolute(rel)) return null;
  const segments = rel.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;

  try {
    const realRoot = await realpath(root);
    const real = await realpath(join(realRoot, ...segments));
    const inside = relative(realRoot, real);
    if (
      inside === '' ||
      inside === '..' ||
      inside.startsWith(`..${sep}`) ||
      isAbsolute(inside) // another drive on Windows
    ) {
      return null;
    }
    if (extname(real) !== '.jpg') return null;
    return (await stat(real)).isFile() ? real : null;
  } catch {
    return null; // missing, not readable, a loop of links
  }
}
