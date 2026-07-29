// Provide dummy values for required env vars so config.ts loads without
// throwing — tests should never depend on real credentials.
process.env.CC_SLACK_BOT_TOKEN ??= "xoxb-test";
process.env.CC_SLACK_APP_TOKEN ??= "xapp-test";
process.env.CC_SLACK_SIGNING_SECRET ??= "test-signing-secret";
process.env.LITELLM_BASE_URL ??= "http://localhost:4000/v1";
process.env.LITELLM_API_KEY ??= "litellm-test-key";
process.env.LITELLM_MODEL ??= "test-model";
process.env.LITELLM_REQUEST_TIMEOUT_MS ??= "120000";
process.env.SLACK_WORKSPACE_URL ??= "https://test.slack.com";

// Silence console output during tests to keep output clean.
// This runs as a setupFile (before test framework), so we patch directly.
console.log = () => {};
console.warn = () => {};
console.error = () => {};
