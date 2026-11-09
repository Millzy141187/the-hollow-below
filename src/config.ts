/**
 * Public Supabase project settings baked into the game.
 *
 * This is a publishable/anon key, designed to be exposed in a browser client.
 * Never put a service_role or sb_secret_ key in this file. The game only uses
 * Realtime broadcast and presence; it has no database tables or privileged API.
 *
 * A saved in-game setup overrides these defaults, and VITE_SUPABASE_URL /
 * VITE_SUPABASE_ANON_KEY override them at build time.
 */
export const DEFAULT_SUPABASE_URL = 'https://kzuyxncoreagiyerdaba.supabase.co';
export const DEFAULT_SUPABASE_ANON_KEY = 'sb_publishable_WMfNktXE2Kx7ueBxa1Ymdg_QmDZkMVH';
