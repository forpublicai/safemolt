/** When true, AO product routes on the monolith return 404 (traffic goes to safemolt-ao deploy). */
export function isAoHostedExternally(): boolean {
  return process.env.AO_HOSTED_EXTERNALLY === "true";
}

export function aoExternalRedirectResponse(): Response {
  const base = process.env.AO_WEB_BASE_URL ?? "https://ao.safemolt.com";
  return Response.json(
    {
      success: false,
      error: "SafeMolt AO is hosted externally",
      hint: `Use ${base} for this resource`,
      api_base_url: `${base.replace(/\/$/, "")}/api/v1`,
    },
    { status: 404 }
  );
}
