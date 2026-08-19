/**
 * Pull the assertion tally out of a suite's own output.
 *
 * Exit code alone is not evidence a suite ran. `startProxy` used to exit *0*
 * when the port it wanted was already held by a healthy dario, so a suite
 * could bind nothing, assert nothing, and be counted as passed — and eight of
 * them could reach that state on a developer box with dario running. The
 * contract change in proxy.ts removes that particular route; this removes the
 * whole class, by requiring a suite to say how many assertions it made.
 *
 * The suites predate any shared reporter and each prints its own tally, so
 * this reads the spellings actually in use rather than imposing a new one:
 * "N pass, M fail" and its "passed"/"failed"/"Results:" variants, the
 * two-line TAP-ish "# pass N" / "# fail N", "N/M checks passed", a bare "N
 * assertions passed", and finally per-assertion "PASS <label>" lines for the
 * one suite that prints no summary at all.
 *
 * Returns null when none match, which the runner treats as a failure — a new
 * suite has to report something countable to be scored as a pass.
 */
export function readTally(text) {
  // "N pass, M fail" / "N passed, M failed" / "Results: N passed, M failed"
  let last = null;
  for (const m of text.matchAll(/(\d+)\s+pass(?:ed)?\s*,\s*(\d+)\s+fail(?:ed)?/gi)) {
    last = { pass: +m[1], fail: +m[2] };
  }
  if (last) return last;

  // TAP-ish, printed on two lines: "# pass N" then "# fail N".
  const tapPass = [...text.matchAll(/^#\s*pass\s+(\d+)\s*$/gim)].pop();
  const tapFail = [...text.matchAll(/^#\s*fail\s+(\d+)\s*$/gim)].pop();
  if (tapPass) return { pass: +tapPass[1], fail: tapFail ? +tapFail[1] : 0 };

  // "N/M checks passed"
  const ratio = [...text.matchAll(/(\d+)\s*\/\s*(\d+)\s+checks?\s+passed/gi)].pop();
  if (ratio) return { pass: +ratio[1], fail: +ratio[2] - +ratio[1] };

  // "N assertions passed" — suites that only ever report a success count.
  const only = [...text.matchAll(/(\d+)\s+assertions?\s+passed/gi)].pop();
  if (only) return { pass: +only[1], fail: 0 };

  // Per-assertion "PASS <label>" / "FAIL <label>" lines with no summary. The
  // lines are the tally.
  const pass = (text.match(/^\s*PASS\s+\S/gm) ?? []).length;
  const fail = (text.match(/^\s*FAIL\s+\S/gm) ?? []).length;
  if (pass || fail) return { pass, fail };

  return null;
}
