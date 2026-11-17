// Cloudflare Pages Function: serves the CINTEXA API from the same origin as the web app, so /api/* works
// without a separately hosted Worker or CINTEXA_API_BASE. It reuses the Worker handler unchanged.
// Optional: bind the D1 database as `DB` (and add the secrets from .env.example) in Pages > Settings > Functions
// to enable historical intelligence; public market data works without any binding.
import worker from '../../worker/src/index.js';

export const onRequest = context => worker.fetch(context.request, context.env, context);
