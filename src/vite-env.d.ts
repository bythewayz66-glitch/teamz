/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Default provider for a fresh browser (users can switch at runtime):
   * unset / 'pollinations' → Pollinations.ai, 'live' → each agent's endpointUrl,
   * 'mock' → canned offline replies.
   */
  readonly VITE_API_MODE?: 'pollinations' | 'mock' | 'live';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
