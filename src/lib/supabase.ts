/**
 * Shared Supabase client configuration
 * 
 * This file provides a single Supabase client instance that can be imported
 * and used across all pages. This avoids duplicating the configuration in
 * multiple HTML files.
 */

import { createClient } from '@supabase/supabase-js';

// Environment variables (these will be set in .env file)
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://iwjnsgjzbratogyiespi.supabase.co';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml3am5zZ2p6YnJhdG9neWllc3BpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk3MTExMjEsImV4cCI6MjA3NTI4NzEyMX0.QmPziA27iNQ4ZXmptlm-hkrhy3JgknK5VsekYl7aCPQ';

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables. Please check your .env file.');
}

// Create and export the Supabase client
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

/**
 * Type definitions for database tables
 * These match your existing Supabase schema
 */

export interface Roast {
  id: string;
  user_id: string;
  filename: string;
  file_url: string;
  upload_date: string;
  roaster: string | null;
  origin: string | null;
  variety: string | null;
  roast_date: string | null;
  process: string | null;
  charge_mass: number | null;
  final_mass: number | null;
  ambient_temp: number | null;
  relative_humidity: number | null;
}

export interface TrainingJob {
  id: string;
  user_id: string;
  job_name: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  config: Record<string, any>;
  roast_file_ids: string[];
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  loss_history: Record<string, any> | null;
  duration_seconds: number | null;
  modal_call_id: string | null;
}
