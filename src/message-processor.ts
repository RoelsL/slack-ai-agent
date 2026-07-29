import { AgentStreamEvent } from "./agent-types";
import { RequestMode } from "./request-mode";
import { ConversationSession, PhaseTimings, SlackContext, TokenUsage } from "./types";
import { Logger } from "./logger";
import { REACTIONS } from "./reaction-manager";

export interface MessageProcessorResult {
  messages: string[];
  shouldNotRespond: boolean;
  debugLogs?: string[];
  toolCalls?: string[];
  toolCallNames?: string[];
  confirmationDialogPosted?: boolean;
  tokenUsage?: TokenUsage;
  turnCount?: number;
  costUsd?: number;
  phaseTimings?: PhaseTimings;
}

interface AgentStreamProvider {
  streamQuery(
    prompt: string,
    session: ConversationSession,
    abortController?: AbortController,
    workingDirectory?: string,
    slackContext?: SlackContext,
    onRetry?: (attempt: number) => void,
    systemPrompt?: string,
    requestMode?: RequestMode,
  ): AsyncGenerator<AgentStreamEvent, void, unknown>;
}

interface ReactionSink {
  updateReaction(sessionKey: string, reaction: string): Promise<void>;
}

interface MessageChannelConfig {
  shouldUseEphemeralMessaging(channel: string): Promise<boolean>;
  getEphemeralTargetUsers(channel: string): Promise<string[]>;
  isConditionalReplyChannel(
    channel: string,
    channelType: SlackContext["channelType"],
  ): Promise<boolean>;
}

export class MessageProcessor {
  private logger = new Logger("MessageProcessor");

  constructor(
    private readonly agentHandler: AgentStreamProvider,
    private readonly reactionManager: ReactionSink,
    private readonly channelConfig: MessageChannelConfig,
  ) {}

  /** Process one provider-neutral text stream and retain the public result shape. */
  async processAgentStream(
    prompt: string,
    session: ConversationSession,
    abortController: AbortController,
    workingDirectory?: string,
    slackContext?: SlackContext,
    sessionKey?: string,
    systemPrompt?: string,
    _allowFullLogging?: boolean,
    requestMode?: RequestMode,
  ): Promise<MessageProcessorResult> {
    const messages: string[] = [];
    const debugLogs: string[] = [];
    let tokenUsage: TokenUsage | undefined;
    let costUsd: number | undefined;
    let shouldNotRespond = false;
    let turnCount = 0;
    let streamedText = "";
    const toolCalls: string[] = [];
    const toolCallNames: string[] = [];
    let confirmationDialogPosted = false;
    const phaseTimings: PhaseTimings = {};
    const started = Date.now();
    let first = false;
    let isConditionalReplyChannel: boolean | undefined;

    const honorsDoNotRespond = async (text: string): Promise<boolean> => {
      if (!/DO_NOT_RESPOND/i.test(text) || !slackContext) return false;
      if (isConditionalReplyChannel === undefined) {
        isConditionalReplyChannel =
          await this.channelConfig.isConditionalReplyChannel(
            slackContext.channel,
            slackContext.channelType,
          );
      }
      return isConditionalReplyChannel;
    };

    if (sessionKey && slackContext && await this.shouldShowReactions(slackContext)) {
      await this.reactionManager.updateReaction(sessionKey, REACTIONS.THINKING);
    }
    for await (const event of this.agentHandler.streamQuery(
      prompt, session, abortController, workingDirectory, slackContext,
      undefined, systemPrompt, requestMode,
    )) {
      if (!first) {
        phaseTimings.provider_time_to_first_message_ms = Date.now() - started;
        first = true;
      }
      this.processEvent(event, messages, debugLogs);
      if (event.type === "assistant") {
        turnCount++;
        const text = event.message.content.map(part => part.text).join("");
        streamedText += text;
        if (await honorsDoNotRespond(text)) shouldNotRespond = true;
      } else if (event.type === "result") {
        if (event.usage) tokenUsage = event.usage;
        if (event.totalCostUsd !== undefined) {
          costUsd = event.totalCostUsd;
        }
        if (await honorsDoNotRespond(event.result)) shouldNotRespond = true;
      } else if (event.type === "tool_result") {
        toolCalls.push(event.result);
        toolCallNames.push(event.toolName);
        if (/confirmation dialog|Do not send any additional text/i.test(event.result)) {
          confirmationDialogPosted = true;
          shouldNotRespond = true;
        }
      }
    }
    phaseTimings.provider_total_stream_ms = Date.now() - started;
    messages.length = 0;
    if (streamedText) messages.push(streamedText);
    this.logger.info("✅ Completed", { msgs: messages.length, turns: turnCount });
    return {
      messages,
      shouldNotRespond,
      debugLogs: prompt.includes("[DEBUG]") ? debugLogs : undefined,
      tokenUsage,
      costUsd,
      turnCount: turnCount || undefined,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      toolCallNames: toolCallNames.length ? toolCallNames : undefined,
      confirmationDialogPosted: confirmationDialogPosted || undefined,
      phaseTimings,
    };
  }

  private processEvent(event: AgentStreamEvent, messages: string[], debugLogs: string[]): void {
    if (event.type === "assistant") {
      const text = event.message.content.map(part => part.text).join("");
      if (text && !messages.includes(text)) messages.push(text);
      return;
    }
    // The assistant event is authoritative for text. The result is metadata,
    // so never append its result and duplicate a streamed answer.
    if (event.type === "result" && event.subtype === "error") debugLogs.push("Provider returned an error result");
  }

  private async shouldShowReactions(context: SlackContext): Promise<boolean> {
    const ephemeral = await this.channelConfig.shouldUseEphemeralMessaging(context.channel);
    return !(ephemeral && !context.explicitMention &&
      (await this.channelConfig.getEphemeralTargetUsers(context.channel)).length > 0);
  }
}
