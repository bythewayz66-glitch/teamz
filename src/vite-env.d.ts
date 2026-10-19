/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 'mock' (default) runs fully local; 'live' calls each agent's endpointUrl. */
  readonly VITE_API_MODE?: 'mock' | 'live';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
