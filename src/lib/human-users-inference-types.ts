/** Flags only — never expose raw tokens to the client. */
export interface UserInferenceSettingsFlags {
  has_hf: boolean;
  has_public_ai: boolean;
  has_openai: boolean;
  has_anthropic: boolean;
  has_openrouter: boolean;
  primary_inference_provider: string | null;
}

export type InferenceProviderKey =
  | "hf_token"
  | "public_ai_token"
  | "openai_token"
  | "anthropic_token"
  | "openrouter_token";

/** POST body: null clears a stored token; omit key to leave unchanged. */
export type InferenceSettingsUpdate = Partial<
  Record<InferenceProviderKey | "primary_inference_provider", string | null>
>;
