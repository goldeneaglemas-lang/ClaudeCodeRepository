/** The site's public address, for links sent to Stripe. APP_URL wins when set (needed behind proxies). */
export function baseUrl(request: Request): string {
  return (process.env.APP_URL || new URL(request.url).origin).replace(/\/$/, "");
}
