export type EffortLevel = never;

/** Model aliases are deployment configuration values resolved by LiteLLM. */
export type AllowedModel = string;

export interface RequestMode {
  model?: AllowedModel;
}

export interface ChannelModeConfig {
  model?: AllowedModel;
}

export const DEFAULT_MODEL_ALIAS = "LITELLM_MODEL";

/** Retained compatibility shape; no text or emoji provider modes are parsed. */
export interface ModeTriggerEmojis {}
export const resolveMode = (
  text: string | undefined,
  channelMode: ChannelModeConfig | undefined,
  explicitMention?: boolean,
  modeTriggerEmojis?: ModeTriggerEmojis,
): RequestMode => {
  // Request text and unsupported provider hints are intentionally ignored.
  return channelMode?.model ? { model: channelMode.model } : {};
};
