describe("LiteLLM configuration validation", () => {
  const requiredVariables = {
    CC_SLACK_BOT_TOKEN: "xoxb-test",
    CC_SLACK_APP_TOKEN: "xapp-test",
    CC_SLACK_SIGNING_SECRET: "signing-test",
    LITELLM_BASE_URL: "http://localhost:4000/v1",
    LITELLM_API_KEY: "key-test",
    LITELLM_MODEL: "model-test",
    LITELLM_REQUEST_TIMEOUT_MS: "120000",
    SLACK_WORKSPACE_URL: "https://test.slack.com",
  };

  function withEnvironment(
    changes: Partial<Record<keyof typeof requiredVariables, string | undefined>>,
    assertion: () => void,
  ): void {
    const original = { ...process.env };
    try {
      for (const [key, value] of Object.entries(requiredVariables)) {
        process.env[key] = value;
      }
      for (const [key, value] of Object.entries(changes)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      jest.isolateModules(assertion);
    } finally {
      process.env = original;
    }
  }

  it.each([
    "LITELLM_BASE_URL",
    "LITELLM_API_KEY",
    "LITELLM_MODEL",
  ])("rejects missing %s", variable => {
    withEnvironment(
      { [variable]: undefined },
      () => expect(() => require("./config")).toThrow(`Missing required environment variable: ${variable}`),
    );
  });

  it.each(["NaN", "0", "-1", "", "abc"]) (
    "rejects invalid timeout %s",
    value => {
      withEnvironment(
        { LITELLM_REQUEST_TIMEOUT_MS: value || " " },
        () => expect(() => require("./config")).toThrow(
          "Invalid environment variable: LITELLM_REQUEST_TIMEOUT_MS",
        ),
      );
    },
  );
});
