# HTTP security and cache

Probe real responses for:

- exact status and redirect chain;
- content type and charset;
- CSP or an explicitly documented equivalent;
- frame protection, nosniff, referrer and permissions policies;
- HSTS only in an HTTPS-capable environment;
- cache-control appropriate to public, private, authenticated and personalized content;
- cookies with Secure, HttpOnly and SameSite as applicable.

Do not expose cookie values in evidence. A page rendering “not found” is not a 404 proof. A local
framework server cannot prove CDN behavior; mark production cache behavior unverified until tested
in preview/production-like infrastructure.
