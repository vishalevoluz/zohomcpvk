// Best-effort static analysis over Deluge function source text. This is a
// pattern-matching scanner, not a real Deluge compiler/interpreter — findings
// are phrased as "likely"/"may"/"possible" rather than certainties, same
// heuristic tone the rest of this app's predicates already use (see
// crmPredicates.ts). Verified against real Deluge source pulled from a live
// org via ZohoCRM_getFunctionCode: API calls take two shapes — zoho.crm.*(...)
// parenthesized calls, and invokeurl [ ... ] bracket blocks (no parens) — both
// are matched below.

export type FunctionIssueCategory =
  | "error-handling"
  | "runtime"
  | "compile-time"
  | "logic"
  | "performance"
  | "api-consumption";

export interface FunctionIssue {
  category: FunctionIssueCategory;
  severity: "high" | "medium" | "low";
  message: string;
}

export const ISSUE_CATEGORY_LABELS: Record<FunctionIssueCategory, string> = {
  "error-handling": "Missing Error Handling",
  "runtime": "Potential Runtime Error",
  "compile-time": "Compile-Time Error",
  "logic": "Wrong Condition Logic",
  "performance": "Unoptimized / Slow Logic",
  "api-consumption": "Excessive API Consumption",
};

const SEVERITY_ORDER: Record<FunctionIssue["severity"], number> = { high: 0, medium: 1, low: 2 };
export function sortIssuesBySeverity(issues: FunctionIssue[]): FunctionIssue[] {
  return [...issues].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

// zoho.crm.*(...) and sendmail(...) are parenthesized; invokeurl is a bracket
// block with no parens at all ("invokeurl\n[ ... ]") — matched as a bare
// keyword rather than requiring a "(" after it.
const API_CALL_PATTERN = /\bzoho\.crm\.[a-zA-Z]+\s*\(|\binvokeurl\b|\bsendmail\s*\(|\bzoho\.crm\.bulk\.[a-zA-Z]+\s*\(/gi;
const LOOP_START_PATTERN = /\b(for\s+each\s+\w+\s+in\s+[\w.\[\]"']+|while\s*\([^)]*\))\s*\{/gi;

function countOccurrences(re: RegExp, text: string): number {
  const matches = text.match(re);
  return matches ? matches.length : 0;
}

// Finds every loop body via brace-matching (not just a regex on the whole
// script) so an API-call-in-loop check isn't fooled by a loop keyword and an
// API call that both happen to appear in the script but in unrelated places.
function loopBodies(script: string): string[] {
  const bodies: string[] = [];
  const re = new RegExp(LOOP_START_PATTERN.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(script))) {
    const start = m.index + m[0].length; // just past the opening {
    let depth = 1;
    let i = start;
    while (i < script.length && depth > 0) {
      if (script[i] === "{") depth++;
      else if (script[i] === "}") depth--;
      i++;
    }
    bodies.push(script.slice(start, i - 1));
  }
  return bodies;
}

function hasBalancedDelimiters(script: string): boolean {
  const pairs: Record<string, string> = { "}": "{", ")": "(", "]": "[" };
  const stack: string[] = [];
  let inString: '"' | "'" | null = null;
  for (let i = 0; i < script.length; i++) {
    const c = script[i];
    if (inString) {
      if (c === "\\") { i++; continue; }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'") { inString = c as '"' | "'"; continue; }
    if (c === "{" || c === "(" || c === "[") stack.push(c);
    else if (c === "}" || c === ")" || c === "]") {
      if (stack.pop() !== pairs[c]) return false;
    }
  }
  return stack.length === 0 && inString === null;
}

const API_CONSUMPTION_THRESHOLD = 8;
const LONG_FUNCTION_LINE_THRESHOLD = 150;

export function analyzeFunctionScript(script: string): FunctionIssue[] {
  const issues: FunctionIssue[] = [];
  if (!script || !script.trim()) return issues;

  // Compile-time: unbalanced braces/parens/brackets or an unterminated string
  // almost always means the function won't save/compile in Zoho at all.
  if (!hasBalancedDelimiters(script)) {
    issues.push({
      category: "compile-time", severity: "high",
      message: "Unbalanced braces, parentheses, brackets, or an unterminated string — this function likely fails to save or compile in Zoho.",
    });
  }

  const apiCallCount = countOccurrences(API_CALL_PATTERN, script);
  const hasTry = /\btry\s*\{/i.test(script);

  // Error handling: any function calling out to the CRM API, a webhook, or
  // sending mail with no try/catch anywhere crashes the whole run on one bad
  // response instead of failing gracefully.
  if (apiCallCount > 0 && !hasTry) {
    issues.push({
      category: "error-handling", severity: "medium",
      message: `${apiCallCount} API call${apiCallCount !== 1 ? "s" : ""} (zoho.crm.*, invokeurl, or sendmail) with no try/catch anywhere in the function — one failed call crashes the whole run instead of failing gracefully.`,
    });
  }

  // Wrong conditions: a lone "=" inside an if(...)'s parens (not ==, !=, <=,
  // >=) is almost always a stray assignment where a comparison was meant.
  const conditionAssignRe = /if\s*\(([^()]*)\)/gi;
  let condMatch: RegExpExecArray | null;
  while ((condMatch = conditionAssignRe.exec(script))) {
    const inner = condMatch[1];
    if (/[^=!<>]=(?!=)/.test(inner)) {
      issues.push({
        category: "logic", severity: "high",
        message: `Possible assignment (=) instead of comparison (==) inside an if condition: "if(${inner.trim()})" — this always evaluates truthy and silently skips the intended check.`,
      });
      break; // one flag is enough context; avoid spamming near-duplicate hits
    }
  }

  // Performance / unoptimized logic: an API call inside a loop body means
  // every iteration burns a separate round-trip — the classic N+1 pattern
  // that both slows the function down and burns through Zoho's API rate limit.
  for (const body of loopBodies(script)) {
    if (countOccurrences(API_CALL_PATTERN, body) > 0) {
      issues.push({
        category: "performance", severity: "high",
        message: "API call inside a loop — this fires once per iteration instead of batching. For any real record volume this both slows the function down and can exhaust Zoho's per-minute API limit.",
      });
      break; // report the pattern once, not once per loop found
    }
  }

  // Excessive API consumption: even outside a loop, a function doing a lot of
  // separate API round-trips is a slow-response / rate-limit risk.
  if (apiCallCount > API_CONSUMPTION_THRESHOLD) {
    issues.push({
      category: "api-consumption", severity: "medium",
      message: `${apiCallCount} separate API calls in one function — consider batching with zoho.crm.bulk.* or combining requests to reduce round-trips.`,
    });
  }

  // Slow response heuristic: a long function with loops is the shape of
  // something that will visibly lag as data volume grows.
  const lineCount = script.split("\n").length;
  const hasLoop = new RegExp(LOOP_START_PATTERN.source, "i").test(script);
  if (lineCount > LONG_FUNCTION_LINE_THRESHOLD && hasLoop) {
    issues.push({
      category: "performance", severity: "low",
      message: `Long function (${lineCount} lines) containing loops — likely to run slowly as record volume grows. Consider splitting into smaller functions or moving heavy logic to a scheduled batch job.`,
    });
  }

  // Runtime heuristic: reading a map value (e.g. a fetched record's field)
  // and using it immediately with no nearby null/containsKey check is a
  // common source of a null-key runtime error when the expected key or
  // record isn't actually present.
  const mapGetRe = /(\w+)\.get\(([^)]+)\)/g;
  let getMatch: RegExpExecArray | null;
  while ((getMatch = mapGetRe.exec(script))) {
    const nearbyStart = Math.max(0, getMatch.index - 120);
    const nearby = script.slice(nearbyStart, getMatch.index);
    if (!/containskey|!=\s*null|isnull|==\s*null/i.test(nearby)) {
      issues.push({
        category: "runtime", severity: "low",
        message: `"${getMatch[1]}.get(${getMatch[2].trim()})" is read with no nearby null/containsKey check — if the key or record is missing this throws at runtime instead of failing gracefully.`,
      });
      break; // one flag is enough context; avoid spamming every .get() call
    }
  }

  return issues;
}

// ─── Code quality / style review ───────────────────────────────────────────────
// A separate, lighter pass from analyzeFunctionScript above — this one is about
// readability and maintainability (formatting, comments), not correctness or
// performance risk, so it's surfaced as its own "Zia" recommendation rather
// than mixed into the issues list.

export interface CodeQualityInsight {
  commentRatioPct: number;
  summary: string;
}

const LONG_LINE_THRESHOLD = 120;

export function reviewCodeQuality(script: string): CodeQualityInsight {
  if (!script || !script.trim()) return { commentRatioPct: 0, summary: "No code to review." };

  const lines = script.split("\n");
  const codeLines = lines.filter(l => l.trim() !== "");
  const fullLineComments = lines.filter(l => /^\s*\/\//.test(l)).length;
  // Inline "//" comments, excluding URLs (http://, https://) which contain "//"
  // but aren't comments.
  const inlineComments = lines.filter(l => !/^\s*\/\//.test(l) && /\/\//.test(l) && !/https?:\/\//.test(l)).length;
  const commentSignal = fullLineComments + inlineComments;
  const commentRatioPct = codeLines.length > 0 ? Math.round((commentSignal / codeLines.length) * 100) : 0;

  const longLines = lines.filter(l => l.length > LONG_LINE_THRESHOLD).length;
  // Leading-whitespace shape only, not a full indent-width/nesting-depth
  // check — good enough to catch the common "tabs in some lines, spaces in
  // others" inconsistency without a real Deluge parser.
  const usesTabs = lines.some(l => /^\t/.test(l));
  const usesSpaces = lines.some(l => /^ {2,}/.test(l));
  const mixedIndentation = usesTabs && usesSpaces;
  const hasLongBlankRun = /\n{4,}/.test(script);

  const parts: string[] = [];

  if (commentSignal === 0 && codeLines.length > 10) {
    parts.push("no comments anywhere in the function — add a few lines explaining what it does and why, especially around any non-obvious business logic");
  } else if (commentRatioPct < 5 && codeLines.length > 20) {
    parts.push(`only ${commentRatioPct}% of lines are commented — a function this size benefits from more explanation of why, not just what`);
  } else if (commentSignal > 0) {
    parts.push(`comments cover roughly ${commentRatioPct}% of the code`);
  }

  if (mixedIndentation) {
    parts.push("mixes tabs and spaces for indentation — pick one so it reads consistently in every editor");
  }
  if (longLines > 0) {
    parts.push(`${longLines} line${longLines !== 1 ? "s" : ""} over ${LONG_LINE_THRESHOLD} characters — consider breaking these up for readability`);
  }
  if (hasLongBlankRun) {
    parts.push("has stretches of 3+ blank lines in a row — trim these for a tighter, more readable function");
  }

  if (parts.length === 0) {
    return { commentRatioPct, summary: "Formatting and commenting look solid — no readability issues flagged." };
  }
  return { commentRatioPct, summary: `Zia's formatting review: ${parts.join("; ")}.` };
}
