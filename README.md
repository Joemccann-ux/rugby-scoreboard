# Rugby Scoreboard

Desktop app (Mac + Windows) for running an LED rugby scoreboard from a laptop.

## Getting the apps
Every change to this repository builds new apps automatically (about 10 minutes).
Go to **Releases** (right-hand side of the repository page) and download from the latest build:

- **Mac:** `Rugby-Scoreboard-Mac.zip`
- **Windows:** `Rugby-Scoreboard-Windows-Setup.exe` (installer) or `Rugby-Scoreboard-Windows-Portable.exe` (no install)

## Updating the club list
The clubs that appear in the Home/Away dropdowns live in the `clubs` folder.

1. **Add the badge:** open `clubs/badges` → **Add file → Upload files** → drag in the badge
   (PNG with a transparent background, about 400×400). Use simple file names, e.g. `melksham.png`.
2. **Add the club:** open `clubs/clubs.csv` → click the pencil (Edit) → add a line:

   ```
   club_name,board_name,badge_file,name_colour,team_colour
   Melksham RFC,MELKSHAM,melksham.png,#FFFFFF,#265086
   ```
   - `club_name` – shown in the dropdown
   - `board_name` – shown on the scoreboard (keep it short)
   - `badge_file` – the file name you uploaded
   - `name_colour` – colour of the name on the board (leave as `#FFFFFF` for white)
   - `team_colour` – the club's main colour
   - `try_video` / `conversion_video` – optional MP4s in `clubs/videos` that play when that club scores
     (clubs without their own use `generic-try.mp4` / `generic-conversion.mp4`)
   - `sponsors` – optional sponsor logos in `clubs/sponsors` (separate several with `;`), shown under the
     clock only when that club is the home team
3. Click **Commit changes**. New apps appear under Releases about 10 minutes later.


## Files
- `app/index.html` – the scoreboard and control screens
- `main.js` – desktop app: finds the scoreboard screen and puts the picture on it
- `clubs/` – club list and badges, built into the app
- `.github/workflows/build.yml` – builds the Mac and Windows apps
