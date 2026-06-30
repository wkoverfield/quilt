// Prototype A — the Labeled-Write Ledger.
//
// Capture authorship AT THE EDIT, from the tool-call payload (old_string ->
// new_string), never from a post-write disk re-read. Each edit appends an event;
// ownership is a REPLAY of the log over a position-tagged buffer, so identity is
// a recorded fact and duplicate identical lines stay distinct (keyed by position,
// not by line text). This is the mechanism we're testing against the status quo.

/** Split into lines, dropping a single trailing newline's empty tail. */
function lines(s) {
  const out = s.split("\n");
  if (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

/**
 * A ledger is just an ordered list of edit events. In real Quilt these are
 * appended to .quilt/authorship.log by the MCP edit tool / hook; here we hold
 * them in memory for the eval.
 */
export function newLedger() {
  return { events: [], seq: 0 };
}

/**
 * Record one edit, exactly as the MCP `quilt_edit` tool would: the actor, the
 * path, and the payload (oldStr -> newStr). The payload IS the actor's exact
 * contribution — no disk re-read, so a sibling writing concurrently can't taint
 * it. `intent` rides along for the sew.
 */
export function recordEdit(ledger, actor, path, oldStr, newStr, intent) {
  ledger.events.push({
    seq: ledger.seq++,
    actor,
    path,
    oldLines: lines(oldStr),
    newLines: lines(newStr),
    intent,
  });
}

/** Whole-file write (e.g. quilt_write / new file): the actor authored all of it. */
export function recordWrite(ledger, actor, path, content, intent) {
  ledger.events.push({
    seq: ledger.seq++,
    actor,
    path,
    oldLines: null, // whole-file
    newLines: lines(content),
    intent,
    whole: true,
  });
}

import { lineDiff } from "../../dist/diff.js";

/**
 * Apply one edit to a position-tagged buffer, attributing ONLY the genuinely
 * new/changed lines to `actor` — context lines (present in both old and new)
 * keep their prior author. This is the fair definition of "authored": the lines
 * this actor actually introduced. Used by both the ledger replay and the
 * harness's ground truth, so they share one notion of authorship.
 */
export function applyEdit(buf, oldLines, newLines, actor) {
  const at = indexOfSpan(buf, oldLines);
  if (at === -1) {
    // anchor not found at replay time — real Quilt falls to the inference floor.
    return buf.concat(newLines.map((text) => ({ text, author: actor })));
  }
  const ops = lineDiff(oldLines.join("\n"), newLines.join("\n"));
  const replacement = [];
  let oldIdx = at; // position in buf of the current old line
  for (const op of ops) {
    if (op.type === "eq") {
      replacement.push(buf[oldIdx]); // keep prior author
      oldIdx++;
    } else if (op.type === "del") {
      oldIdx++; // drop
    } else {
      replacement.push({ text: op.text, author: actor }); // genuinely new -> this actor
    }
  }
  return buf.slice(0, at).concat(replacement, buf.slice(at + oldLines.length));
}

/** Locate the first occurrence of `needle` (array of lines) in `hay`; -1 if absent. */
function indexOfSpan(hay, needle) {
  if (needle.length === 0) return -1;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j].text !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

/**
 * Replay the ledger into a position-tagged buffer per path, then read off the
 * author of every line. Returns { path: [{text, author}] }.
 *
 * The key property: because we apply each event positionally and tag the new
 * lines with that event's actor, two actors who add the identical line in
 * different places are recorded as two distinct, correctly-authored lines — the
 * exact case content-keyed inference collapses.
 */
export function ownershipFromLedger(ledger, seedFiles = {}) {
  const bufs = {};
  for (const [p, content] of Object.entries(seedFiles)) {
    bufs[p] = lines(content).map((text) => ({ text, author: null })); // baseline = unowned
  }
  for (const ev of ledger.events.sort((a, b) => a.seq - b.seq)) {
    const buf = (bufs[ev.path] ??= []);
    if (ev.whole || ev.oldLines === null) {
      bufs[ev.path] = ev.newLines.map((text) => ({ text, author: ev.actor }));
      continue;
    }
    bufs[ev.path] = applyEdit(buf, ev.oldLines, ev.newLines, ev.actor);
  }
  return bufs;
}

/** Map a replayed buffer to { lineText -> author } for comparison (last write wins on dup text). */
export function authorByLine(buf) {
  const m = new Map();
  for (const { text, author } of buf) m.set(text, author);
  return m;
}
