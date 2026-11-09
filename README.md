# THE HOLLOW BELOW

A co-operative 2D roguelike horror game for **15+**. Descend procedurally generated
catacombs alone or with a party, recover three fuses, and reach the stairwell before
the things in the dark find you.

Built with TypeScript, Canvas 2D and **Supabase Realtime** for co-op
(broadcast + presence; no database tables required).

**Live:** <https://the-hollow-below.vercel.app>  
**Source:** <https://github.com/Millzy141187/the-hollow-below>

---

## Content warning

This is a horror game intended for players **15 and older**. It contains:

- blood, gore and mutilated bodies
- sustained tension and jump scares
- sudden loud sounds
- flashing lights and screen shake (a reduce-effects option is in the menu)

There is no account system, no chat, and no purchases. It runs entirely in the browser.

## Features

- **Procedural dungeon** — rooms, corridors, decoration, candles and blood are generated
  deterministically from a shared seed, so every co-op player explores the same map.
- **Two-to-four player co-op** — create a 4-character room code and share it. Each player
  gets their own screen, torch and vitals; monsters are shared.
- **Host-authoritative co-op** — the room host simulates monster AI and relays damage;
  players sync position, attacks and pickups over Supabase Realtime at ~12 Hz.
- **Survival horror systems** — a draining flashlight, sprint stamina, medical kits,
  battery cells, dread, heartbeat audio, limited vision, fog of war and permadeath per run.
- **Three creature types** — crawlers, stalkers and wailers, scaling with depth.
- **Full solo mode** — works offline with no Supabase keys at all.
- **Synthesized audio** — drone, heartbeat, footsteps, screams, impacts. No audio assets.
- **No assets to license** — every sprite, texture and sound is generated at runtime.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # type-check + production bundle in dist/
npm run preview  # serve the production build
```

Desktop browser with a keyboard and mouse is recommended.

## Connect your Supabase (multiplayer)

The deployed build is already configured with a public Supabase project in
`src/config.ts`, so **Create co-op room** works immediately on the live site — no
setup required. The in-game setup panel can still override it with a different
project; settings saved in that browser win over the build defaults.

If you are connecting a different project, you only need its **public anon /
publishable key**. Never put a `service_role` secret in a browser game.

1. Open your project at [supabase.com/dashboard](https://supabase.com/dashboard)
   (for example `Afterdark-the-last-frontier` or `spoolora`).
2. Go to **Project Settings → API** (or **API Keys**).
3. Copy the **Project URL** (e.g. `https://abcdefgh.supabase.co`) and the
   **anon / publishable** key.
4. In the game menu choose **Multiplayer setup — connect Supabase**, paste both
   values, and press **Save & test**. The keys are stored only in that browser's
   `localStorage`.
5. Press **Create co-op room**, then share the 4-letter code.

Realtime is enabled by default on Supabase projects. No SQL, tables, policies or
Edge Functions are used — rooms are ephemeral Realtime channels (`hollow:CODE`).

### Optional: bake settings into a build

Copy `.env.example` to `.env` and fill in:

```dotenv
VITE_SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR-PUBLIC-ANON-KEY
```

`src/config.ts` holds the built-in defaults. `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY` override them for a custom build, and a saved in-game
setup overrides both. Only the public anon/publishable key belongs in a browser.

## How to play

| Input | Action |
| --- | --- |
| `WASD` / arrows | Move |
| `Shift` | Sprint (drains breath) |
| Mouse | Aim |
| Left mouse / `Space` | Strike with the pipe |
| `F` | Toggle flashlight |
| `E` | Pick up / use stairs |
| `Esc` | Pause |
| `M` | Mute |

Find **three fuses** in the dark. The stairwell seal breaks when the party has all
three. Stand on the stairwell and press `E` to descend together. Each depth is harder;
dead players are revived at the start of the next depth. If everyone dies, the run ends.

Sprinting is limited by breath. The flashlight slowly drains its battery, and its
light reveals the map. Dread rises near creatures, in darkness and at low health; it
is mostly a warning, and it makes the screen less stable.

## Multiplayer notes and limitations

- Co-op is trust-based: each client owns its own health, and the host validates
  attacks and pickups loosely. It is designed for friends, not competitive play.
- Room codes are the only access control. Anyone with the code can join the channel.
- Host migration is best effort. If the host disconnects, the earliest remaining
  player takes over the monster simulation; there may be a brief hitch.
- No progress is stored. Closing the tab ends the run.
- Supabase free-plan Realtime limits apply (connections and message volume).
- Multiplayer requires WebSocket support; restrictive corporate networks can block it.

### Troubleshooting

- **"Could not join the room"** — check the project URL, the anon key (not a secret
  key), and that Realtime is enabled in Supabase.
- **"No party answered"** — the code is wrong, the host left, or the host's tab was
  suspended. Create a fresh room.
- **No sound until you click** — browsers require a user gesture before audio starts;
  the first button press unlocks it.
- **Black screen** — check the browser console; Canvas 2D is required.

## Architecture

```
src/main.ts          menu, age gate, Supabase setup, room lifecycle, HUD, end screen
src/config.ts        public Supabase project defaults baked into the client
src/net.ts           Supabase Realtime channel: broadcast messages + presence roster
src/game/game.ts     game loop, lighting, AI, combat, floors, rendering, host sync
src/game/dungeon.ts  seeded dungeon generation, collision and line of sight
src/game/audio.ts    Web Audio synthesized ambience and effects
src/game/rng.ts      deterministic PRNG helpers
src/types.ts         shared game/network types
```

Networking uses one channel per room. `presence` carries the roster, host flag, seed
and current depth; `broadcast` carries player state, monster snapshots, hit/pickup
events and floor transitions.

## Deployment

`npm run build` produces a static `dist/` folder. Host it on any static host
(Cloudflare Pages, Netlify, Vercel, GitHub Pages). No server or SPA rewrite is needed
because the game is a single page.

The game has no backend of its own: multiplayer traffic goes directly from each
browser to your Supabase project's Realtime service.
