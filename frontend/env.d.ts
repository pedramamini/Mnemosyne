/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL for the Worker API. Defaults to same-origin when unset. */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
