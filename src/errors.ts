// Error → message + exit code mapping. The SDK throws typed errors for every
// non-2xx; here they become one-line human messages on stderr and documented
// exit codes, so scripts can branch on failures without parsing text.
//
// Exit codes:
//   0  success
//   1  unexpected error
//   2  usage error or invalid input (CLI arguments, API 400 validation)
//   3  could not reach the server
//   4  authentication failed (401, missing credential, token refresh failed)
//   5  not found (404)
//   6  conflict (409 state conflict, 412 concurrent edit, 428 missing If-Match)
//   7  permission denied (403)
//   8  rate limited (429)
//   9  server error (5xx)

import {
  CocoApiError,
  CocoAuthenticationError,
  CocoConflictError,
  CocoConnectionError,
  CocoNotFoundError,
  CocoPermissionError,
  CocoPreconditionRequiredError,
  CocoRateLimitError,
  CocoServerError,
  CocoValidationError,
  CocoVersionConflictError,
} from "coconut-sdk";

export const EXIT = {
  ok: 0,
  unexpected: 1,
  usage: 2,
  connection: 3,
  auth: 4,
  notFound: 5,
  conflict: 6,
  permission: 7,
  rateLimit: 8,
  server: 9,
} as const;

/** An error the CLI raises itself, with a chosen exit code. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT.unexpected,
  ) {
    super(message);
    this.name = "CliError";
  }
}

/** The server's own error sentence, when it sent one. */
function serverMessage(error: CocoApiError): string | undefined {
  const body = error.body;
  if (body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string") {
    return (body as { error: string }).error;
  }
  return undefined;
}

export function describeError(error: unknown): { message: string; exitCode: number } {
  if (error instanceof CliError) {
    return { message: error.message, exitCode: error.exitCode };
  }
  if (error instanceof CocoConnectionError) {
    // The SDK wraps anything the fetch layer throws; a CliError cause (e.g.
    // a failed OAuth token refresh) is the real story — unwrap it.
    if (error.cause instanceof CliError) return describeError(error.cause);
    return {
      message: `Could not reach the server: ${error.message}\nCheck the base URL (\`coco auth status\` shows it) and that the deployment is up.`,
      exitCode: EXIT.connection,
    };
  }
  if (error instanceof CocoAuthenticationError) {
    return {
      message: `Authentication failed (401): ${serverMessage(error) ?? "the credential was not accepted"}.\nRun \`coco auth login\` to sign in, or check COCO_API_KEY.`,
      exitCode: EXIT.auth,
    };
  }
  if (error instanceof CocoPermissionError) {
    const lines = [`Permission denied (403): ${serverMessage(error) ?? "the API refused this action"}.`];
    if (error.reasonCode) lines.push(`Reason: ${error.reasonCode}`);
    for (const step of error.nextSteps ?? []) lines.push(`  → ${step}`);
    return { message: lines.join("\n"), exitCode: EXIT.permission };
  }
  if (error instanceof CocoNotFoundError) {
    return {
      message: `Not found (404): ${serverMessage(error) ?? "no such page, space, template, or run"} — or it isn't visible to this credential.`,
      exitCode: EXIT.notFound,
    };
  }
  if (error instanceof CocoVersionConflictError) {
    return {
      message:
        "Concurrent edit (412): the page changed since it was read — someone else wrote a new revision first.\nRe-read it (`coco page get`) and retry against the latest version.",
      exitCode: EXIT.conflict,
    };
  }
  if (error instanceof CocoPreconditionRequiredError) {
    return {
      message:
        "The page already exists and the write carried no version (428). Re-run — the CLI re-reads before updating — or use `coco page get` first.",
      exitCode: EXIT.conflict,
    };
  }
  if (error instanceof CocoConflictError) {
    return {
      message: `Conflict (409): ${serverMessage(error) ?? "the request contradicts current state"}.`,
      exitCode: EXIT.conflict,
    };
  }
  if (error instanceof CocoRateLimitError) {
    const wait = error.retryAfterSeconds ? ` Retry in ~${error.retryAfterSeconds}s.` : "";
    return { message: `Rate limited (429).${wait}`, exitCode: EXIT.rateLimit };
  }
  if (error instanceof CocoValidationError) {
    const detail = serverMessage(error);
    const body = error.body;
    const issues =
      body && typeof body === "object" && Array.isArray((body as { issues?: unknown }).issues)
        ? ((body as { issues: unknown[] }).issues as unknown[])
            .map((issue) => `  → ${typeof issue === "string" ? issue : JSON.stringify(issue)}`)
            .join("\n")
        : "";
    return {
      message: `Invalid input (400): ${detail ?? "the API rejected the request"}.${issues ? `\n${issues}` : ""}`,
      exitCode: EXIT.usage,
    };
  }
  if (error instanceof CocoServerError) {
    return {
      message: `Server error (${error.status}): ${serverMessage(error) ?? "the deployment failed or the feature is unavailable in this runtime"}.`,
      exitCode: EXIT.server,
    };
  }
  if (error instanceof CocoApiError) {
    return { message: error.message, exitCode: EXIT.unexpected };
  }
  return {
    message: error instanceof Error ? error.message : String(error),
    exitCode: EXIT.unexpected,
  };
}
