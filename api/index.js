// Vercel serverless entry — re-exports the Express app from server.js.
// vercel.json rewrites ALL paths to here so Express handles every request
// (both /api/* and the static index.html at /).
export { default } from "../server.js";
