import { closeSync, lstatSync, openSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

/**
 * Hand a freshly minted credential to the user without it passing through the MCP transcript:
 * it goes into a NEW file only the current OS user can read (mode 0600). The file is created
 * exclusively (`wx`: fails on any existing entry, a symbolic link included), so a credential can
 * never overwrite — or be written through a link into — some other file.
 */

/**
 * Check a destination before minting, so a bad path fails while nothing was created yet: absolute,
 * in an existing directory, and not taken by any entry (file, directory or symbolic link).
 */
export function assertNewSecretFilePath(path: string): void {
  if (!isAbsolute(path)) {
    throw new Error(`${path} is not an absolute path — pass the full path of the file to create.`);
  }
  let directory;
  try {
    directory = statSync(dirname(path));
  } catch {
    throw new Error(`The directory ${dirname(path)} does not exist — create it first or pick another path.`);
  }
  if (!directory.isDirectory()) {
    throw new Error(`${dirname(path)} is not a directory.`);
  }
  let existing;
  try {
    existing = lstatSync(path);
  } catch {
    return; // free
  }
  throw new Error(
    existing.isSymbolicLink()
      ? `${path} is a symbolic link — refusing to write a credential through it. Pick a new file path.`
      : `${path} already exists — a credential is only ever written to a new file. Pick a new file path.`,
  );
}

/** Create `path` exclusively with mode 0600 and write `content` into it. */
export function writeNewSecretFile(path: string, content: string): void {
  let descriptor: number;
  try {
    descriptor = openSync(path, 'wx', 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new Error(`${path} already exists — a credential is only ever written to a new file.`);
    throw error;
  }
  try {
    writeFileSync(descriptor, content, 'utf8');
  } finally {
    closeSync(descriptor);
  }
}
