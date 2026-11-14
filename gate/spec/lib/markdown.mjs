// Parsers for the OpenSpec artifacts the Ozea checks read (OPS-67).
// Header syntax follows OpenSpec 2.0.0: "### Requirement:" and "#### Scenario:".
// `openspec validate --strict` remains the authority on structure; these
// parsers only extract what the Ozea rules need.

export const SCENARIO_ID = /^(RCV-[A-Z0-9]{2,12}-\d{3})(?:\s|$)/;
const OP_HEADER = /^## (ADDED|MODIFIED|REMOVED|RENAMED) Requirements\s*$/;
const REQUIREMENT = /^### Requirement:\s*(.+?)\s*#*\s*$/;
const SCENARIO = /^#### Scenario:\s*(.+?)\s*#*\s*$/;
const ORIGIN = /^\s*-\s+\*\*Origin\*\*:\s*(.*)$/;
const SECURITY_NEGATIVE = /^\s*-\s+\*\*Security\*\*:\s*negative\b/i;
const EX_REF = /\bEX-\d+\b/g;

function lines(text) {
  const out = [];
  let fenced = false;
  text.split(/\r?\n/).forEach((raw, index) => {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      return;
    }
    if (!fenced) out.push({ text: raw, line: index + 1 });
  });
  return out;
}

/**
 * Parses a delta spec (changes/<c>/specs/**) or a living spec (openspec/specs/**).
 * Living-spec requirements get op "SPEC".
 */
export function parseSpec(text) {
  const requirements = [];
  let op = null;
  let requirement = null;
  let scenario = null;

  for (const { text: l, line } of lines(text)) {
    const opMatch = l.match(OP_HEADER);
    if (opMatch) {
      op = opMatch[1];
      requirement = scenario = null;
      continue;
    }
    if (/^## Requirements\s*$/.test(l)) {
      op = 'SPEC';
      requirement = scenario = null;
      continue;
    }
    if (/^## /.test(l)) {
      op = null;
      requirement = scenario = null;
      continue;
    }
    const reqMatch = l.match(REQUIREMENT);
    if (reqMatch && op) {
      requirement = { op, name: reqMatch[1], line, scenarios: [] };
      requirements.push(requirement);
      scenario = null;
      continue;
    }
    const scnMatch = l.match(SCENARIO);
    if (scnMatch && requirement) {
      const name = scnMatch[1];
      const id = name.match(SCENARIO_ID);
      scenario = {
        name,
        line,
        id: id ? id[1] : null,
        origins: [],
        hasOrigin: false,
        securityNegative: false,
      };
      requirement.scenarios.push(scenario);
      continue;
    }
    if (scenario) {
      const origin = l.match(ORIGIN);
      if (origin) {
        scenario.hasOrigin = true;
        scenario.origins.push(...(origin[1].match(EX_REF) ?? []));
      }
      if (SECURITY_NEGATIVE.test(l)) scenario.securityNegative = true;
    }
  }
  return { requirements };
}

/** Examples ("- EX-n: ...") listed under "## Examples" in proposal.md. */
export function parseProposal(text) {
  const examples = [];
  let inExamples = false;
  let hasExamplesSection = false;
  for (const { text: l, line } of lines(text)) {
    if (/^## /.test(l)) {
      inExamples = /^## Examples\s*$/.test(l);
      hasExamplesSection ||= inExamples;
      continue;
    }
    if (!inExamples) continue;
    const m = l.match(/^\s*-\s+\*{0,2}(EX-\d+)\*{0,2}\s*:/);
    if (m) examples.push({ id: m[1], line });
  }
  return { hasExamplesSection, examples };
}

/** design.md "## Security" section and its "- **Applies**: yes|no" bullet. */
export function parseDesign(text) {
  let inSecurity = false;
  let hasSecurity = false;
  let applies = null;
  let line = null;
  for (const { text: l, line: n } of lines(text)) {
    if (/^## /.test(l)) {
      inSecurity = /^## Security\s*$/.test(l);
      if (inSecurity) {
        hasSecurity = true;
        line = n;
      }
      continue;
    }
    if (!inSecurity || applies !== null) continue;
    const m = l.match(/^\s*-\s+\*\*Applies\*\*:\s*(yes|no)\b/i);
    if (m) applies = m[1].toLowerCase() === 'yes';
  }
  return { hasSecurity, applies, line };
}

/** Counts "- [ ]" / "- [x]" items in tasks.md. */
export function parseTasks(text) {
  let total = 0;
  let done = 0;
  for (const { text: l } of lines(text)) {
    const m = l.match(/^\s*-\s+\[( |x|X)\]/);
    if (!m) continue;
    total += 1;
    if (m[1] !== ' ') done += 1;
  }
  return { total, done };
}
