// Vercel serverless catch-all — Express app handles all /api/* routes.
// req.url is preserved as the original path (e.g. "/api/health"),
// so Express's existing `app.get("/api/health", ...)` matches.
export { default } from "../server.js";
