// Shared violation/report helpers. Exit codes: 0 ok, 1 violation, 2 usage or
// environment error (an environment error never counts as a pass).

export function violation(code, message, file = null, line = null) {
  return { code, message, file, line };
}

export class UsageError extends Error {}

export function parseArgs(argv, spec) {
  const out = { _: [] };
  for (const [key, def] of Object.entries(spec)) out[key] = def.multiple ? [] : def.default;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const def = spec[key];
    if (!def) throw new UsageError(`unknown option ${arg}`);
    if (def.flag) {
      out[key] = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new UsageError(`${arg} needs a value`);
    if (def.multiple) out[key].push(value);
    else out[key] = value;
  }
  return out;
}

export function printViolations(name, violations, { json = false } = {}) {
  if (json) {
    process.stdout.write(`${JSON.stringify({ check: name, ok: violations.length === 0, violations }, null, 2)}\n`);
    return;
  }
  const annotate = process.env.GITHUB_ACTIONS === 'true';
  for (const v of violations) {
    const where = v.file ? `${v.file}${v.line ? `:${v.line}` : ''}` : '';
    if (annotate) {
      const loc = v.file ? ` file=${v.file}${v.line ? `,line=${v.line}` : ''}` : '';
      process.stdout.write(`::error${loc}::[${name}] ${v.code}: ${v.message}\n`);
    } else {
      process.stdout.write(`${name} ${v.code} ${where} ${v.message}\n`);
    }
  }
  process.stdout.write(`${name}: ${violations.length === 0 ? 'ok' : `${violations.length} violation(s)`}\n`);
}

/** Runs a CLI main(argv) and maps outcomes to exit codes. */
export async function runCli(name, main) {
  try {
    const violations = await main(process.argv.slice(2));
    process.exitCode = violations.length === 0 ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${name}: ${error instanceof UsageError ? 'usage error' : 'error'}: ${error.message}\n`);
    process.exitCode = 2;
  }
}
