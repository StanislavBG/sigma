import { baseSecurityHeaders } from '../app/lib/security';

export const ALLOWED_METHODS = 'GET, HEAD';

export function redirectCleartextHttp(request: Request, isProd: boolean): Response | null {
  if (!isProd) return null;
  const url = new URL(request.url);
  // Behind a TLS-terminating proxy (e.g. a Replit deployment) the Worker is reached over plain http
  // internally even though the client is on https — trust `x-forwarded-proto` so we redirect on the
  // client's real scheme and never loop. On Cloudflare the Worker URL is already https, so the http
  // branch below never fires and this header is absent.
  const forwarded = request.headers.get('x-forwarded-proto');
  const scheme = forwarded ? forwarded.split(',')[0].trim() : url.protocol.replace(':', '');
  if (scheme !== 'http') return null;

  url.protocol = 'https:';
  const headers = baseSecurityHeaders(isProd);
  headers.set('Location', url.toString());

  return new Response(null, {
    status: 301,
    headers,
  });
}

export function optionsResponse(isProd: boolean): Response {
  const headers = baseSecurityHeaders(isProd);
  headers.set('Allow', ALLOWED_METHODS);

  return new Response(null, {
    status: 204,
    headers,
  });
}

export function setAllowHeader(headers: Headers, status: number): void {
  if (status === 405) headers.set('Allow', ALLOWED_METHODS);
}
