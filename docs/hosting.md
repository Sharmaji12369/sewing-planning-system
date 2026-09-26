# Hosting

The app runs on a single Windows PC as two Windows services, published to the internet through a Cloudflare tunnel. Nobody has to be signed in to the PC for the site to be up.

| Service | What | Port |
|---|---|---|
| `SewingPlanningAPI` | the Express API (`backend/`), started after PostgreSQL | 4000 |
| `SewingPlanningWeb` | the built Next.js app (`frontend/`) | 3100 |
| `Cloudflared` | the tunnel that publishes port 3100 | - |

## The service host

`service/SewingHost.cs` is a small C# service program, compiled by the installer with the C# compiler that ships with Windows - no extra tools. It runs `node` as described in `service/api.conf` / `service/web.conf` (program, arguments, working folder, log file, `env.*` variables), restarts it 5 seconds after it stops (backing off to 60 seconds while it keeps failing), and ends it and everything it started when the service stops.

`service/install-services.ps1` (run once, as administrator) builds the host, creates both services and grants the installing account the right to start, stop and restart them - so every later update needs no elevation. `-Uninstall` removes them.

## Updates without an outage

- **API:** `Restart-Service SewingPlanningAPI` - about a second. New database migrations run as it starts.
- **Web app:** `service/deploy-web.ps1`. The site runs from one of two build folders, `.next` or `.next-b` (named by `env.NEXT_DIST_DIR` in `web.conf`). The script builds into the other one while the site keeps running, starts the new build on a spare port and checks that it answers, then points the service at it and restarts it - about a second. If the new build does not come up, it switches straight back. The previous build stays on disk, so going back by hand is one line in `web.conf`.

Changes are tried first on a second copy beside the live one - its own ports and a copy of the database (`dev/testdb.ps1`, `dev/test-api.ps1`, `dev/test-web.ps1`) - so nothing live is touched while a change is being checked.

## Keeping a laptop serving

The host is a laptop with Modern Standby, which needed more than "never sleep":

- On Modern Standby hardware, **the screen turning off is itself a way into standby** - including the lock screen's own display timeout after Windows + L. `service/keep-awake.ps1` sets the screen, lock-screen display, sleep, lid and power-button actions so the machine keeps running, on mains and on battery.
- Windows can **hibernate from standby on battery** ("Standby Battery Budget Exceeded"), which once took the site down overnight. Hibernation is turned off; at critical battery the machine shuts down cleanly instead.
- Wi-Fi stays connected in standby, and the tunnel works from any internet connection.

`-Undo` restores the previous settings.

## When the site is down

`service/fix-site.ps1` checks, in order: the internet, PostgreSQL, the API (including whether it can reach the database), the web app, and the tunnel - and restarts only what is not working, printing the end of the logs for anything that fails. `-CheckOnly` looks without changing anything.
