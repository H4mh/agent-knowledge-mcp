import { readFileSync } from 'node:fs';

export interface GuardRule {
  name: string;
  pattern: string;
}

export interface GuardRules {
  hardReject: GuardRule[];
  warnOnly: GuardRule[];
}

export interface GuardHit {
  rule: string;
  match: string;
}

export interface GuardResult {
  blocked: boolean;
  warnings: string[];
  hits: GuardHit[];
}

export function loadGuardRules(path: string): GuardRules {
  return JSON.parse(readFileSync(path, 'utf8')) as GuardRules;
}

function matchRules(text: string, rules: GuardRule[]): GuardHit[] {
  const hits: GuardHit[] = [];
  for (const rule of rules) {
    const re = new RegExp(rule.pattern, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      hits.push({ rule: rule.name, match: m[0] });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  return hits;
}

export function scanText(text: string, rules: GuardRules): GuardResult {
  const hard = matchRules(text, rules.hardReject);
  const warn = matchRules(text, rules.warnOnly);
  return {
    blocked: hard.length > 0,
    warnings: warn.map((w) => `警告[${w.rule}]: 命中 ${w.match}（内网信息，请自行确认是否应入库）`),
    hits: hard,
  };
}
