# Supabase schema

Applied to the "Timeline Planner" project (`qrkywsxdujxlognlthts`, eu-central-1).
Kept here for reference / re-creation; the app only needs the project URL and
publishable key in `src/sync/client.ts`.

Dashboard toggle required for live updates: **Authentication → Sign In / Providers
→ Anonymous sign-ins → enabled**. Without it the app still shares and saves through
the token-checked RPCs, but refreshes by polling instead of Realtime.
