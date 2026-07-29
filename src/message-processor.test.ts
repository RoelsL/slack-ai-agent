import { AgentStreamEvent } from "./agent-types";
import { MessageProcessor } from "./message-processor";
import { ConversationSession, SlackContext } from "./types";

async function* streamEvents(
  events: AgentStreamEvent[],
): AsyncGenerator<AgentStreamEvent, void, unknown> {
  yield* events;
}

function makeSession(): ConversationSession {
  return {
    userId: "U1",
    channelId: "C1",
    threadTs: "T1",
    workingDirectory: "/tmp/workspace",
    lastActivity: new Date(),
    history: [],
  };
}

function makeContext(): SlackContext {
  return {
    channel: "C1",
    channelType: "channel",
    user: "U1",
  };
}

function makeProcessor(
  events: AgentStreamEvent[],
  conditional: boolean,
): {
  processor: MessageProcessor;
  isConditionalReplyChannel: jest.Mock;
} {
  const agentHandler = {
    streamQuery: jest.fn(() => streamEvents(events)),
  };
  const reactionManager = {
    updateReaction: jest.fn().mockResolvedValue(undefined),
  };
  const isConditionalReplyChannel = jest
    .fn()
    .mockResolvedValue(conditional);
  const channelConfig = {
    shouldUseEphemeralMessaging: jest.fn().mockResolvedValue(false),
    getEphemeralTargetUsers: jest.fn().mockResolvedValue([]),
    isConditionalReplyChannel,
  };
  return {
    processor: new MessageProcessor(
      agentHandler,
      reactionManager,
      channelConfig,
    ),
    isConditionalReplyChannel,
  };
}

async function process(
  processor: MessageProcessor,
  context?: SlackContext,
) {
  return processor.processAgentStream(
    "prompt",
    makeSession(),
    new AbortController(),
    undefined,
    context,
  );
}

describe("MessageProcessor", () => {
  it("returns one normalized message for assistant and final result events", async () => {
    const { processor, isConditionalReplyChannel } = makeProcessor(
      [
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "answer" }] },
        },
        { type: "result", subtype: "success", result: "answer" },
      ],
      false,
    );

    const result = await process(processor, makeContext());

    expect(result.messages).toEqual(["answer"]);
    expect(result.shouldNotRespond).toBe(false);
    expect(isConditionalReplyChannel).not.toHaveBeenCalled();
  });

  it("propagates final usage and cost metadata", async () => {
    const { processor } = makeProcessor(
      [
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "answer" }] },
        },
        {
          type: "result",
          subtype: "success",
          result: "answer",
          usage: { inputTokens: 4, outputTokens: 6 },
          totalCostUsd: 0.012,
        },
      ],
      false,
    );

    const result = await process(processor);

    expect(result.tokenUsage).toEqual({ inputTokens: 4, outputTokens: 6 });
    expect(result.costUsd).toBe(0.012);
  });

  it("honors DO_NOT_RESPOND in a conditional channel", async () => {
    const { processor, isConditionalReplyChannel } = makeProcessor(
      [
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "DO_NOT_RESPOND" }] },
        },
        { type: "result", subtype: "success", result: "DO_NOT_RESPOND" },
      ],
      true,
    );

    const result = await process(processor, makeContext());

    expect(result.shouldNotRespond).toBe(true);
    expect(isConditionalReplyChannel).toHaveBeenCalledTimes(1);
  });

  it("does not honor DO_NOT_RESPOND outside a conditional channel", async () => {
    const { processor, isConditionalReplyChannel } = makeProcessor(
      [
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "DO_NOT_RESPOND" }] },
        },
        { type: "result", subtype: "success", result: "DO_NOT_RESPOND" },
      ],
      false,
    );

    const result = await process(processor, makeContext());

    expect(result.shouldNotRespond).toBe(false);
    expect(isConditionalReplyChannel).toHaveBeenCalledTimes(1);
  });
});
