/// <reference types="vite/client" />

// Type declarations for modules without TypeScript definitions
declare module 'plotly.js-dist-min' {
  import * as Plotly from 'plotly.js';
  export = Plotly;
}

/**
 * Environment variable types for Vite
 * This file provides TypeScript type definitions for import.meta.env
 */

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
