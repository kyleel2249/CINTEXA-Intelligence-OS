// Runtime configuration, loaded before the application and served as-is (not bundled).
// Set CINTEXA_API_BASE to the Worker origin (no trailing slash) when the API is hosted on a different hostname,
// for example 'https://cintexa-intelligence-os-api.<account>.workers.dev'. Leave empty for same-origin routing.
// The Worker CORS_ORIGIN variable must then be set to this site's exact origin.
window.CINTEXA_API_BASE = window.CINTEXA_API_BASE || '';
