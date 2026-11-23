/**
 * Google's own error, in words. Google answers with a short code (`access_denied`, `invalid_grant`) and sometimes a sentence;
 * the person needs to know what to change in their Cloud project. Both are shown: the explanation first, then what Google said.
 */
const HINTS: Record<string, string> = {
  access_denied:
    "Google didn't let this account in. If the consent screen's audience is External and in Testing, add the account under Audience, Test users; if it is Internal, sign in with an account of that Workspace organisation.",
  org_internal: "This client is Internal to another Google Workspace organisation, so only its members can sign in. Sign in with an account of that organisation, or make your own client.",
  invalid_client: "Google doesn't know this client ID and secret (or the client was deleted). Paste them again from Credentials in the Cloud console; the client must be a Desktop app.",
  unauthorized_client: "Google doesn't allow this client to sign in this way. Make a new OAuth client of type Desktop app and paste its ID and secret.",
  redirect_uri_mismatch: "This client is not a Desktop app, so Google refuses the sign-in address. Make a new OAuth client of type Desktop app and paste its ID and secret.",
  invalid_grant:
    "Google ended this sign-in. A consent screen in Testing ends sign-ins after 7 days: set Audience to Internal (Workspace) or press Publish app (In production), then connect again. The code or token may also be used already, or the access revoked.",
  admin_policy_enforced: "A Google Workspace admin restricts this app. Ask them to allow it (Admin console, Security, API controls), then connect again.",
  disabled_client: "This OAuth client is disabled in the Cloud console. Enable it or make a new one.",
  invalid_request: "Google refused the request as malformed; connect again from the board's Connect button.",
};

/** `code` and Google's `description` as one sentence for the board. */
export function explainGoogle(code: string | undefined, description?: string): string {
  const hint = code ? HINTS[code] : undefined;
  const said = [code, description].filter(Boolean).join(": ");
  return hint ? `${hint} (Google said: ${said})` : said ? `Google said: ${said}` : "Google refused the sign-in without saying why.";
}

/** The error of a failed Google REST call ({ error: { code, message, status } }), with the usual cause named. */
export function explainApi(status: number, body: { error?: { message?: string; status?: string } | string; error_description?: string } | undefined): string {
  const e = body?.error;
  const message = typeof e === "string" ? [e, body?.error_description].filter(Boolean).join(": ") : (e?.message ?? "");
  if (/has not been used in project|is disabled|accessNotConfigured/i.test(message)) {
    return `A Google API isn't turned on in your project: press Enable on Calendar, Drive and Gmail in the Cloud console's API library. (Google said: ${message})`;
  }
  return message ? `Google said: ${message}` : `Google answered ${status}`;
}
