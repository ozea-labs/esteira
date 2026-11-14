#!/usr/bin/env node
// Stands in for PHPUnit in the tests. Results come from $FAKE_PHPUNIT_DIR:
// the "green/" pair when the working directory has an IMPLEMENTED marker file
// (the implementation commit), "red/" otherwise (the lock commit), or the
// directory itself when it has no such subfolders. Copies list.xml or
// junit.xml to the path after --list-tests-xml / --log-junit and exits 1 when
// the junit has a failure, like PHPUnit.

import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const base = process.env.FAKE_PHPUNIT_DIR;
const variant = existsSync(join(process.cwd(), 'IMPLEMENTED')) ? 'green' : 'red';
const dir = existsSync(join(base, variant)) ? join(base, variant) : base;
const args = process.argv.slice(2);
const listAt = args.indexOf('--list-tests-xml');
const junitAt = args.indexOf('--log-junit');
if (listAt >= 0) {
  copyFileSync(join(dir, 'list.xml'), args[listAt + 1]);
} else if (junitAt >= 0) {
  copyFileSync(join(dir, 'junit.xml'), args[junitAt + 1]);
  process.exitCode = /<(failure|error)\b/.test(readFileSync(join(dir, 'junit.xml'), 'utf8')) ? 1 : 0;
} else {
  process.exitCode = 2;
}
