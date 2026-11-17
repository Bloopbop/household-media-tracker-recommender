# Phase 0 checklist

Phase 0 answers one question: can a home-screen web app on these two phones keep
a database on the device, reach the three data services directly, and work with
no network? If yes, the build continues as a web app. If not, the same code gets
wrapped in a native shell (Tauri) and the rest of the plan is unchanged.

Test page: <https://bloopbop.github.io/household-media-tracker-recommender/>

Run every step on **both** phones: the Galaxy S24 in Chrome and the iPhone 14 in
Safari.

## Before you start

- Have the TMDB key (or token) and the OMDb key ready to paste.
- Do everything from the home-screen app, not the browser tab. On an iPhone the
  installed app has its own storage, separate from Safari's.
- Keep the app open in one place at a time. The database can be open in only
  one tab or window; a second one fails the database check.

## Steps

1. Open the test page in the browser.
2. Add it to the home screen.
   - iPhone: Share, then Add to Home Screen.
   - Galaxy: the browser menu, then Install app or Add to Home screen.
3. Open the app from its home-screen icon. If "Offline shell installed" says
   to reload, close the app and open it again.
4. Look at "Storage protected from eviction".
   - If it shows **Pass**, the browser has already granted it. There is no
     button and nothing to do.
   - If it shows **Check**, tap **Ask the browser to protect storage**. The
     line under the check then says whether the browser granted or declined.
5. Paste both keys, check the country code, and tap **Run online checks**.
   The four Services checks should pass and a poster should appear.
6. Close the app completely (swipe it away) and reopen it. "Data survives
   closing the app" should pass and the launch number should have gone up.
   The launch number is at the top of the page, beside the count of passed
   checks.
7. Turn on airplane mode, and check that Wi-Fi is off as well: some phones
   leave it connected. Close the app completely and reopen it. The pill at the
   top should read **No network**, both Offline checks should pass, and the
   poster should still show. Turn airplane mode off.
8. Restart the phone and open the app. The launch number should continue from
   where it was, not start again at 1, and the keys should still be filled in.
9. Leave the app unopened for a day, then open it. The launch number should
   continue. On the iPhone, repeating this after a week is the real test of
   long-term storage.
10. Tap **Copy results** and send the text from each phone.

The copied results contain statuses, counts and timings only. They hold no keys
and nothing returned by the services.

## What counts as a pass

Gate 0 passes when, on both phones:

- all eleven checks show Pass after step 8, and
- the launch number never resets.

"Storage protected from eviction" may stay at Check on some browsers even when
everything else works. Report it as it is; that case is a judgement call, not
an automatic failure.

## If something fails

Send the copied results anyway. The detail line under each check says what the
browser reported, which is what decides the next step.
