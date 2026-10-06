# Promo video — shot script (YouTube, ~45–60 s)

> The Chrome Web Store listing takes a YouTube link as its promotional video.
> Record the real extension UI with the same synthetic `*.example` demo data
> as the store screenshots (`tests/e2e/store-assets.spec.ts` seeds it). No
> real bookmarks, no provider logos, no fabricated UI. Keep it screen-only —
> captions instead of narration is fine and avoids localization work.

## Before recording

- Load the built extension (`npm run build` → `.output/chrome-mv3`) in a
  throwaway Chromium profile; seed the synthetic tree.
- Window 1280×800, browser zoom 100 %, hide bookmarks bar and other
  extensions. Disable notifications so nothing pops mid-take.
- Record at 1280×800 (store screenshot size), 60 fps if the tool allows.
- Use the same gradient caption style as `store/assets/source/promo.html`.

## Shot list

| # | Time | Screen | Action | Caption |
|---|------|--------|--------|---------|
| 1 | 0:00–0:05 | Title card | Static brand card (name + logo) | "Bookmarks Manager — your bookmarks, organized on your device" |
| 2 | 0:05–0:12 | Popup over a page | Open popup, type title, add tag `recipes`, click Save | "Save the page in one click — popup, shortcut, or right-click" |
| 3 | 0:12–0:22 | Side panel manager | Open side panel, expand Work, hover rows | "Side panel manager: folders, tags, notes, categories" |
| 4 | 0:22–0:32 | Command palette | Ctrl+K, type `api`, arrow through results, Enter | "Search everything from anywhere — fuzzy, instant, offline" |
| 5 | 0:32–0:40 | Duplicates view | Open More → Duplicates, show two groups, open one | "Find duplicates and merge in one move" |
| 6 | 0:40–0:47 | Options → Connections | Show the LLM provider disclosure region | "Optional AI: your key, your provider, consent before anything is sent" |
| 7 | 0:47–0:55 | Side panel | Export dialog (JSON) then the Delete-all confirmation | "Import/export your data. Delete everything anytime." |
| 8 | 0:55–1:00 | End card | Static | "Offline by default · No account · Chrome Web Store" |

Cut points must land on completed actions (dialog open, result list stable),
never mid-animation. Total 55–60 s including the two cards.

## YouTube upload

- Title: `Bookmarks Manager — local-first bookmark organizer (Chrome extension)`
- Description: one line on the offline core + one line on the optional
  key-based AI, then the privacy policy URL and the homepage URL.
- Category: Science & Technology; no paid promotion; not made for kids.
- Visibility: unlisted until the store submission, then switch to public the
  day the listing goes live.
- Thumbnails: export frame from shot 3 or reuse the marquee tile
  (`store/assets/marquee-1400x560.png`).

## Where the URL is recorded

Paste the final `https://www.youtube.com/watch?v=…` link into:

1. `store/listing.md` → **Assets** → Promotional video line (this is what
   `npm run check:store:public` greps for).
2. `store/releases/1.0.0-public-checklist.md` → submission worksheet row.
3. The Developer Dashboard → **Store listing** → "Promotional video" field.
