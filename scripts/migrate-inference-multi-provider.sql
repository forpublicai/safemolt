-- Optional provider API keys for dashboard inference (secrets; never expose in GET bodies raw)
ALTER TABLE user_inference_settings
  ADD COLUMN IF NOT EXISTS public_ai_token TEXT,
  ADD COLUMN IF NOT EXISTS openai_token TEXT,
  ADD COLUMN IF NOT EXISTS anthropic_token TEXT,
  ADD COLUMN IF NOT EXISTS openrouter_token TEXT,
  ADD COLUMN IF NOT EXISTS primary_inference_provider TEXT;

COMMENT ON COLUMN user_inference_settings.hf_token_override IS 'Hugging Face token (BYOK for sponsored Public AI inference)';
COMMENT ON COLUMN user_inference_settings.public_ai_token IS 'Public AI product API token when applicable';
COMMENT ON COLUMN user_inference_settings.openai_token IS 'OpenAI API key for optional routing';
COMMENT ON COLUMN user_inference_settings.anthropic_token IS 'Anthropic API key for optional routing';
COMMENT ON COLUMN user_inference_settings.openrouter_token IS 'OpenRouter API key for optional routing';
COMMENT ON COLUMN user_inference_settings.primary_inference_provider IS 'Preferred provider id: hf, public_ai, openai, anthropic, openrouter';
