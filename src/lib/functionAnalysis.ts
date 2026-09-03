// Best-effort static analysis over Deluge function source text. This is a
// pattern-matching scanner, not a real Deluge compiler/interpreter - findings
// are phrased as "likely"/"may"/"possible" rather than certainties, same
// heuristic tone the rest of this app's predicates already use (see
// crmPredicates.ts). Verified against real Deluge source pulled from a live
// org via ZohoCRM_getFunctionCode: API calls take two shapes - zoho.crm.*(...)
// parenthesized calls, and invokeurl [ ... ] bracket blocks (no parens) - both
// are matched below.

export type FunctionIssueCategory =
  | "error-handling"
  | "runtime"
  | "compile-time"
  | "logic"
  | "performance"
  | "api-consumption"
  | "hardcoded"
  | "duplicate-risk"
  | "field-validity"
  | "code-noise"
  | "naming"
  | "documentation"
  | "scan-error";

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
  "hardcoded": "Hardcoded Value",
  "duplicate-risk": "Possible Duplicate-Record Risk",
  "field-validity": "Unverified Field API Name",
  "code-noise": "Excessive Info Statements",
  "naming": "Vague Variable Naming",
  "documentation": "Missing Description",
  "scan-error": "Code Could Not Be Checked",
};

const SEVERITY_ORDER: Record<FunctionIssue["severity"], number> = { high: 0, medium: 1, low: 2 };
export function sortIssuesBySeverity(issues: FunctionIssue[]): FunctionIssue[] {
  return [...issues].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

// zoho.crm.*(...) and sendmail(...) are parenthesized; invokeurl is a bracket
// block with no parens at all ("invokeurl\n[ ... ]") - matched as a bare
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

// Extracts each full zoho.crm.*(...) invocation (via paren-balance, so nested
// parens/commas inside arguments don't truncate the match early) - used both
// for the repeated-call check and for the duplicate-record heuristic below.
function extractApiCallInvocations(script: string): string[] {
  const calls: string[] = [];
  const startRe = /\bzoho\.crm\.[a-zA-Z]+\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = startRe.exec(script))) {
    const openParenIdx = m.index + m[0].length - 1;
    let depth = 1;
    let i = openParenIdx + 1;
    while (i < script.length && depth > 0) {
      if (script[i] === "(") depth++;
      else if (script[i] === ")") depth--;
      i++;
    }
    calls.push(script.slice(m.index, i).replace(/\s+/g, " ").trim());
  }
  return calls;
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
      message: "Unbalanced braces, parentheses, brackets, or an unterminated string - this function likely fails to save or compile in Zoho.",
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
      message: `${apiCallCount} API call${apiCallCount !== 1 ? "s" : ""} (zoho.crm.*, invokeurl, or sendmail) with no try/catch anywhere in the function - one failed call crashes the whole run instead of failing gracefully.`,
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
        message: `Possible assignment (=) instead of comparison (==) inside an if condition: "if(${inner.trim()})" - this always evaluates truthy and silently skips the intended check.`,
      });
      break; // one flag is enough context; avoid spamming near-duplicate hits
    }
  }

  // Performance / unoptimized logic: an API call inside a loop body means
  // every iteration burns a separate round-trip - the classic N+1 pattern
  // that both slows the function down and burns through Zoho's API rate limit.
  const foundLoopBodies = loopBodies(script);
  for (const body of foundLoopBodies) {
    if (countOccurrences(API_CALL_PATTERN, body) > 0) {
      issues.push({
        category: "performance", severity: "high",
        message: "API call inside a loop - this fires once per iteration instead of batching. For any real record volume this both slows the function down and can exhaust Zoho's per-minute API limit.",
      });
      break; // report the pattern once, not once per loop found
    }
  }

  // Nested loops: a loop body that itself contains another loop start is
  // O(n²)-or-worse iteration - often masking a lookup that should be indexed
  // (e.g. a map keyed by ID) instead of scanned per-outer-iteration.
  for (const body of foundLoopBodies) {
    if (new RegExp(LOOP_START_PATTERN.source, "i").test(body)) {
      issues.push({
        category: "performance", severity: "medium",
        message: "Nested loop detected - a loop running inside another loop multiplies the iteration count. Consider building a lookup map before the outer loop instead of re-scanning the inner list every time.",
      });
      break;
    }
  }

  // Unnecessary/repeated API calls: the exact same zoho.crm.* invocation
  // (same method, same arguments) appearing more than once means the result
  // was very likely fetchable once and reused from a variable instead.
  const apiCallCounts = new Map<string, number>();
  for (const call of extractApiCallInvocations(script)) {
    apiCallCounts.set(call, (apiCallCounts.get(call) ?? 0) + 1);
  }
  for (const [call, count] of apiCallCounts) {
    if (count > 1) {
      const shown = call.length > 140 ? `${call.slice(0, 140)}…` : call;
      issues.push({
        category: "api-consumption", severity: "medium",
        message: `The exact same API call appears ${count} times: "${shown}" - cache the result in a variable the first time instead of calling it again with identical arguments.`,
      });
      break; // one flag is enough context; avoid spamming near-duplicate hits
    }
  }

  // Missing API response/error handling: a call result assigned to a variable
  // should be checked (e.g. response.get("status") / .get("code")) before
  // being used - otherwise a failed call silently continues with bad or
  // empty data instead of being caught.
  const apiAssignRe = /(\w+)\s*=\s*(?=zoho\.crm\.[a-zA-Z]+\s*\()/gi;
  let assignMatch: RegExpExecArray | null;
  while ((assignMatch = apiAssignRe.exec(script))) {
    const varName = assignMatch[1];
    const windowStart = assignMatch.index + assignMatch[0].length;
    const window = script.slice(windowStart, Math.min(script.length, windowStart + 400));
    const checkRe = new RegExp(`${varName}\\s*(\\[|\\.get\\(\\s*["']?(status|code))`, "i");
    if (!checkRe.test(window)) {
      issues.push({
        category: "error-handling", severity: "medium",
        message: `The response from an API call assigned to "${varName}" doesn't appear to be checked (e.g. ${varName}.get("status") or .get("code")) before use - a failed call would silently continue with bad or empty data.`,
      });
      break; // one flag is enough context; avoid spamming every call site
    }
  }

  // Hardcoded record/user IDs: Zoho record and user IDs are 15-19 digit
  // numeric strings - a literal one baked into the script only works for the
  // exact org/record it was copied from and breaks in any other org, sandbox,
  // or once that record is deleted/recreated. Deluge accepts these both
  // quoted ("4876876000000123456") and as bare numeric literals
  // (zoho.crm.getRecordById("Deals", 4876876000000123456)) - the unquoted
  // form is actually the more common way an ID gets passed as a function
  // argument, so both shapes must be matched or a static ID silently passes
  // this check. The lookbehind/lookahead exclude a match that's part of a
  // longer digit run or a decimal (e.g. a 20+-digit number or "123.456...")
  // so this doesn't misfire on unrelated long numbers.
  const hardcodedIdRe = /["']?(?<![\d.])(\d{15,19})(?![\d.])["']?/g;
  const hardcodedIds = new Set<string>();
  let idMatch: RegExpExecArray | null;
  while ((idMatch = hardcodedIdRe.exec(script))) hardcodedIds.add(idMatch[1]);
  if (hardcodedIds.size > 0) {
    const shown = [...hardcodedIds].slice(0, 3).join(", ");
    issues.push({
      category: "hardcoded", severity: "medium",
      message: `Hardcoded record/user ID${hardcodedIds.size !== 1 ? "s" : ""} found (${shown}${hardcodedIds.size > 3 ? ", …" : ""}) - this only works in the org it was copied from. Pass IDs in as function arguments or look them up dynamically instead.`,
    });
  }

  // Hardcoded values: a literal email address baked into the script (most
  // often a sendmail "to") only ever notifies one inbox, in every org this
  // function runs in - it should come from a field, parameter, or config record.
  if (/["'][\w.+-]+@[\w-]+\.[\w.-]+["']/.test(script)) {
    issues.push({
      category: "hardcoded", severity: "low",
      message: "Hardcoded email address found in the function - recipients should typically come from a field, parameter, or config record so this works correctly across every org/environment, not just the one it was written for.",
    });
  }

  // Duplicate-record risk: creating a record with no search/lookup beforehand
  // means re-running this function for the same input (a retry, a re-fired
  // workflow, a bulk re-import) creates a second record instead of updating
  // the existing one.
  const createRecordRe = /zoho\.crm\.createRecord\s*\(\s*["']([\w]+)["']/gi;
  let createMatch: RegExpExecArray | null;
  while ((createMatch = createRecordRe.exec(script))) {
    const before = script.slice(Math.max(0, createMatch.index - 600), createMatch.index);
    if (!/searchrecords|searchbycriteria|search_record|getrecords|zoho\.crm\.search/i.test(before)) {
      issues.push({
        category: "duplicate-risk", severity: "medium",
        message: `A record is created in "${createMatch[1]}" with no search/lookup beforehand - if this function runs more than once for the same input (a retry, a re-fired workflow, a bulk re-import) it can create a duplicate record instead of updating the existing one.`,
      });
      break; // one flag is enough context; avoid spamming every create call
    }
  }

  // Invalid/unknown CRM field API names: this is a static scanner, not a
  // connection to the org's actual field metadata, so it can only catch the
  // unambiguous case - a field key containing a space is always a display
  // label, never a real Zoho API name (API names use underscores).
  const spacedFieldRe = /\.get\(\s*["']([A-Za-z][\w]*\s[\w ]*)["']\s*\)/;
  const spacedFieldMatch = spacedFieldRe.exec(script);
  if (spacedFieldMatch) {
    issues.push({
      category: "field-validity", severity: "medium",
      message: `Field key "${spacedFieldMatch[1]}" contains a space - Zoho API names never do (e.g. "First_Name", not "First Name"). This looks like a display label used by mistake and will return null instead of the intended field value.`,
    });
  }

  // Excessive/unnecessary info statements: fine for one-off debugging, but
  // left in production they add execution overhead and clutter function logs
  // - especially costly when one fires on every iteration of a loop.
  const INFO_STATEMENT_RE = /\binfo\s+[^;]+;/gi;
  const infoCount = countOccurrences(INFO_STATEMENT_RE, script);
  const infoInLoop = foundLoopBodies.some(body => new RegExp(INFO_STATEMENT_RE.source, "i").test(body));
  const INFO_STATEMENT_THRESHOLD = 5;
  if (infoCount > INFO_STATEMENT_THRESHOLD || infoInLoop) {
    issues.push({
      category: "code-noise", severity: "low",
      message: `${infoCount} info statement${infoCount !== 1 ? "s" : ""} found${infoInLoop ? ", including at least one inside a loop" : ""} - keep these for active debugging only; left in place they add overhead and clutter the function's execution log.`,
    });
  }

  // Excessive API consumption: even outside a loop, a function doing a lot of
  // separate API round-trips is a slow-response / rate-limit risk.
  if (apiCallCount > API_CONSUMPTION_THRESHOLD) {
    issues.push({
      category: "api-consumption", severity: "medium",
      message: `${apiCallCount} separate API calls in one function - consider batching with zoho.crm.bulk.* or combining requests to reduce round-trips.`,
    });
  }

  // Slow response heuristic: a long function with loops is the shape of
  // something that will visibly lag as data volume grows.
  const lineCount = script.split("\n").length;
  const hasLoop = new RegExp(LOOP_START_PATTERN.source, "i").test(script);
  if (lineCount > LONG_FUNCTION_LINE_THRESHOLD && hasLoop) {
    issues.push({
      category: "performance", severity: "low",
      message: `Long function (${lineCount} lines) containing loops - likely to run slowly as record volume grows. Consider splitting into smaller functions or moving heavy logic to a scheduled batch job.`,
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
        message: `"${getMatch[1]}.get(${getMatch[2].trim()})" is read with no nearby null/containsKey check - if the key or record is missing this throws at runtime instead of failing gracefully.`,
      });
      break; // one flag is enough context; avoid spamming every .get() call
    }
  }

  // Vague/generic variable naming: a first assignment (Deluge has no var/let
  // keyword - the first "name = value;" at statement level is the
  // declaration) whose name is a meaningless filler word ("abc", "temp",
  // "data1") or a single letter tells a future reader nothing about what it
  // holds, unlike a real Deluge idiom like "leadRec" or "resp".
  const GENERIC_VAR_NAME_RE = /^(?:abc|xyz|foo|bar|baz|qux|asdf|blah|dummy|sample|temp|tmp|test|data|val|value|var|obj|item|thing|stuff|[a-z])\d*$/i;
  const assignmentRe = /(?:^|[;{}\n])\s*([a-zA-Z_]\w*)\s*=(?!=)/g;
  const genericVarNames = new Set<string>();
  let assignMatch2: RegExpExecArray | null;
  while ((assignMatch2 = assignmentRe.exec(script))) {
    const name = assignMatch2[1];
    if (GENERIC_VAR_NAME_RE.test(name)) genericVarNames.add(name);
  }
  if (genericVarNames.size > 0) {
    const shown = [...genericVarNames].slice(0, 3).join(", ");
    issues.push({
      category: "naming", severity: "low",
      message: `Vague variable name${genericVarNames.size !== 1 ? "s" : ""} found (${shown}${genericVarNames.size > 3 ? ", …" : ""}) - a name like this tells a future reader nothing about what it holds. Use a descriptive name instead (e.g. "leadRec" or "dealAmount", not "abc" or "temp").`,
    });
  }

  return issues;
}

// Metadata-level check, separate from analyzeFunctionScript above since it
// reads the function's own name/description (from the function list) rather
// than its Deluge source - a function with no description at all is easy to
// mis-identify or misuse later, especially once several similarly-named
// functions exist (see the Duplicate Function Names check).
export function checkFunctionMetadata(fn: { name?: string; description?: string | null }): FunctionIssue[] {
  const issues: FunctionIssue[] = [];
  if (!fn.description || !fn.description.trim()) {
    issues.push({
      category: "documentation", severity: "high",
      message: `"${fn.name ?? "This function"}" has no description set - add one explaining what it does and why, so it isn't a guess for the next person (or you, in six months) who has to figure out whether it's safe to change or delete.`,
    });
  }
  return issues;
}

// ─── Code quality / style review ───────────────────────────────────────────────
// A separate, lighter pass from analyzeFunctionScript above - this one is about
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
  // check - good enough to catch the common "tabs in some lines, spaces in
  // others" inconsistency without a real Deluge parser.
  const usesTabs = lines.some(l => /^\t/.test(l));
  const usesSpaces = lines.some(l => /^ {2,}/.test(l));
  const mixedIndentation = usesTabs && usesSpaces;
  const hasLongBlankRun = /\n{4,}/.test(script);

  const parts: string[] = [];

  if (commentSignal === 0 && codeLines.length > 10) {
    parts.push("no comments anywhere in the function - add a few lines explaining what it does and why, especially around any non-obvious business logic");
  } else if (commentRatioPct < 5 && codeLines.length > 20) {
    parts.push(`only ${commentRatioPct}% of lines are commented - a function this size benefits from more explanation of why, not just what`);
  } else if (commentSignal > 0) {
    parts.push(`comments cover roughly ${commentRatioPct}% of the code`);
  }

  if (mixedIndentation) {
    parts.push("mixes tabs and spaces for indentation - pick one so it reads consistently in every editor");
  }
  if (longLines > 0) {
    parts.push(`${longLines} line${longLines !== 1 ? "s" : ""} over ${LONG_LINE_THRESHOLD} characters - consider breaking these up for readability`);
  }
  if (hasLongBlankRun) {
    parts.push("has stretches of 3+ blank lines in a row - trim these for a tighter, more readable function");
  }

  if (parts.length === 0) {
    return { commentRatioPct, summary: "Formatting and commenting look solid - no readability issues flagged." };
  }
  return { commentRatioPct, summary: `Zia's formatting review: ${parts.join("; ")}.` };
}
