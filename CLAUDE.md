# Notes for Claude

- **Always verify before handing anything over:** never give the user code, a script, a fix or a
  file without first running it and checking that it works. Run the real thing where possible
  (tests, `node --check`, the function itself against mocked inputs, the app). When it can't be run
  here (e.g. Apps Script against the live sheet), test the logic with a mock and say plainly what
  was and wasn't verified. Report failures honestly; never say "done" or "fixed" on an unchecked change.

- **Google Apps Script:** whenever the Google Sheet script (`google-sheet/daily-total.gs`) is
  created or changed, always hand the user the full script as a `.txt` file (e.g.
  `google-sheet/daily-total.txt`, sent with the file-sharing tool) so it can be pasted straight
  into Extensions → Apps Script. Keep the `.txt` identical to the `.gs`.
