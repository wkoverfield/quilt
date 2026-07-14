import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { basename } from "node:path";
import type { Store } from "./state.js";
import { fleetSnapshot } from "./fleet.js";
import { fileBlame } from "./blame.js";
import { shortHead } from "./git.js";
import { repoRelative } from "./paths.js";
import { initSymbols } from "./symbols.js";
import { VERSION } from "./version.js";

/**
 * `quilt ui` — the fleet dashboard as a local web page. Same data as
 * `quilt fleet` (fleetSnapshot, strictly read-only), rendered live in a
 * browser: who wrote what, active claims, and the "Needs you" queue.
 *
 * Local-only by design: the server binds 127.0.0.1 and refuses requests whose
 * Host header isn't a loopback name (a browser lured to an attacker's DNS name
 * that resolves to 127.0.0.1 — DNS rebinding — sends that name in Host, so the
 * check keeps remote pages from reading fleet state through the visitor's own
 * machine). No account, no remote state, nothing written.
 */

export const DEFAULT_UI_PORT = 4747;

export interface UiServer {
  server: Server;
  port: number;
  url: string;
}

function loopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  // Strip the port; tolerate IPv6 brackets.
  const host = hostHeader.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** Start the dashboard server on 127.0.0.1. Falls back to an ephemeral port
 * when the preferred one is taken, so `quilt ui` always comes up. */
export async function startUiServer(store: Store, preferredPort: number): Promise<UiServer> {
  // Symbol-scoped ownership keys only match what reconcile recorded when the
  // tree-sitter grammars are loaded — without this, every owned line reads as
  // unattributed. The CLI initializes at startup; embedders (tests) may not.
  await initSymbols();
  const server = createServer((req, res) => {
    if (!loopbackHost(req.headers.host)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("quilt ui is local-only\n");
      return;
    }
    const parsedUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const url = parsedUrl.pathname;
    if (url === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(PAGE);
      return;
    }
    if (url === "/api/fleet") {
      try {
        const view = fleetSnapshot(store, Date.now());
        const body = JSON.stringify({
          repo: basename(store.paths.repoRoot),
          head: shortHead(store.paths.repoRoot),
          version: VERSION,
          generatedAt: new Date().toISOString(),
          ...view,
        });
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(body);
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }
    if (url === "/api/blame") {
      const requested = parsedUrl.searchParams.get("path");
      const relPath = requested ? repoRelative(store.paths.repoRoot, requested) : null;
      if (!relPath || relPath !== requested) {
        res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "path must be a normalized file inside the repository" }));
        return;
      }
      try {
        const blame = fileBlame(store, relPath);
        if (!blame) {
          res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify({ error: "file has no uncommitted changes" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(blame));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found\n");
  });

  return new Promise((resolvePromise, reject) => {
    let fellBack = false;
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" && !fellBack) {
        fellBack = true;
        server.listen(0, "127.0.0.1");
        return;
      }
      reject(err);
    });
    server.on("listening", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : preferredPort;
      resolvePromise({ server, port, url: `http://127.0.0.1:${port}` });
    });
    server.listen(preferredPort, "127.0.0.1");
  });
}

/** Open `url` in the default browser; quietly do nothing if we can't. */
export function openInBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Headless or no opener — the printed URL is enough.
  }
}

// The whole dashboard is one self-contained page: no assets to serve, no build
// step to keep in sync with tsc's plain-file output, nothing fetched remotely.
// The client script renders exclusively through DOM construction (createElement
// + textContent) — server data never lands in an HTML string.
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Quilt · fleet</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect x='1' y='1' width='6' height='6' rx='1.5' fill='%23e5a06b'/%3E%3Crect x='9' y='1' width='6' height='6' rx='1.5' fill='%238fc46f'/%3E%3Crect x='1' y='9' width='6' height='6' rx='1.5' fill='%235aa9e6'/%3E%3Crect x='9' y='9' width='6' height='6' rx='1.5' fill='%23d074c4'/%3E%3C/svg%3E">
<style>
  :root {
    --bg: #0b0e14; --panel: #11151d; --border: #202634;
    --text: #d7dce5; --dim: #8b93a3; --faint: #5c6474;
    --amber: #e3b34c; --red: #e06c75; --cyan: #5ac8d8; --green: #7fc46f;
    --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  .wrap { max-width: 1060px; margin: 0 auto; padding: 20px 24px 64px; }
  header { display: flex; align-items: center; gap: 12px; padding: 6px 0 18px; flex-wrap: wrap; }
  .mark { display: grid; grid-template-columns: 8px 8px; gap: 2px; }
  .mark i { width: 8px; height: 8px; border-radius: 2px; display: block; background: #2a3140; }
  h1 { font-size: 16px; margin: 0; font-weight: 650; letter-spacing: .01em; }
  h1 span { color: var(--faint); font-weight: 400; }
  .head-meta { color: var(--dim); font-family: var(--mono); font-size: 12px; }
  .spacer { flex: 1; }
  .pulse { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--green); margin-right: 6px; }
  .live { color: var(--dim); font-size: 12px; }
  .live.stale .pulse { background: var(--red); }
  .counts { color: var(--dim); font-size: 12px; }

  section { margin-top: 18px; }
  .label { font-size: 11px; text-transform: uppercase; letter-spacing: .12em; color: var(--faint); margin: 0 0 8px 2px; }
  .label b { color: var(--dim); font-weight: 600; }
  .hint { color: var(--faint); font-family: var(--mono); font-size: 11.5px; margin: 6px 2px 0; }
  .hint code { color: var(--dim); }

  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
  .rows > .card + .card { margin-top: 8px; }

  .needs .card { border: 1px dashed color-mix(in srgb, var(--amber) 55%, var(--border)); background: color-mix(in srgb, var(--amber) 6%, var(--panel)); }
  .clash .card { border: 1px dashed color-mix(in srgb, var(--red) 55%, var(--border)); background: color-mix(in srgb, var(--red) 6%, var(--panel)); }

  .row-title { font-family: var(--mono); font-size: 13px; }
  .row-sub { color: var(--dim); font-size: 12.5px; margin-top: 2px; }
  .row-when { color: var(--faint); font-size: 11.5px; float: right; }

  .actors { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 8px; }
  .actor { border-top: 3px solid var(--border); }
  .actor .id { font-family: var(--mono); font-weight: 600; font-size: 13px; word-break: break-all; }
  .actor .type { color: var(--faint); font-size: 11px; margin-left: 6px; }
  .actor .meta { color: var(--dim); font-size: 12px; margin-top: 6px; }
  .actor .claims { color: var(--faint); font-family: var(--mono); font-size: 11.5px; margin-top: 6px; word-break: break-all; }
  .idle { color: var(--faint); }

  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 11px; color: var(--faint); text-transform: uppercase; letter-spacing: .1em; font-weight: 500; padding: 4px 10px; }
  td { padding: 7px 10px; border-top: 1px solid var(--border); font-size: 13px; vertical-align: top; }
  td.path { font-family: var(--mono); font-size: 12.5px; word-break: break-all; }
  .chip { display: inline-flex; align-items: center; gap: 5px; font-family: var(--mono); font-size: 11.5px;
          border: 1px solid var(--border); border-radius: 99px; padding: 1px 8px 1px 5px; margin: 1px 4px 1px 0; color: var(--text); }
  .chip i { width: 7px; height: 7px; border-radius: 2px; display: inline-block; }
  .chip .n { color: var(--dim); }
  .badge { font-size: 10.5px; border-radius: 4px; padding: 1px 6px; letter-spacing: .04em; margin-left: 4px; }
  .badge.contended { color: var(--red); border: 1px solid color-mix(in srgb, var(--red) 50%, transparent); }
  .badge.adjacent { color: var(--faint); border: 1px solid var(--border); }
  .badge.new { color: var(--green); border: 1px solid color-mix(in srgb, var(--green) 40%, transparent); }
  .badge.deleted, .badge.binary { color: var(--faint); border: 1px solid var(--border); }
  .un { color: var(--faint); font-size: 11.5px; }
  .review-toggle { appearance: none; border: 0; background: none; color: var(--text); padding: 0; cursor: pointer;
                   font: inherit; font-family: var(--mono); text-align: left; }
  .review-toggle::before { content: "▸"; color: var(--faint); display: inline-block; width: 15px; }
  .review-toggle.open::before { content: "▾"; }
  .review-cell { padding: 0 10px 12px; background: color-mix(in srgb, var(--bg) 38%, var(--panel)); }
  .review { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  .review-state { padding: 14px; color: var(--dim); font-size: 12px; }
  .diff-line { display: grid; grid-template-columns: 42px 42px 18px minmax(0, 1fr) auto; align-items: start;
               min-height: 25px; border-top: 1px solid color-mix(in srgb, var(--border) 65%, transparent); font-family: var(--mono); font-size: 11.5px; }
  .diff-line:first-child { border-top: 0; }
  .diff-line.add { background: color-mix(in srgb, var(--green) 7%, transparent); }
  .diff-line.del { background: color-mix(in srgb, var(--red) 7%, transparent); }
  .diff-line.conflict { box-shadow: inset 3px 0 var(--red); }
  .ln { color: var(--faint); text-align: right; padding: 4px 7px 4px 2px; user-select: none; }
  .sign { color: var(--faint); padding: 4px 3px; }
  .code { white-space: pre-wrap; overflow-wrap: anywhere; padding: 4px 8px 4px 2px; }
  .line-meta { padding: 2px 6px; max-width: 360px; text-align: right; }
  .prompt { display: inline-block; text-align: left; margin-left: 4px; vertical-align: top; }
  .prompt summary { color: var(--cyan); cursor: pointer; list-style: none; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 10.5px; }
  .prompt summary::-webkit-details-marker { display: none; }
  .prompt pre { white-space: pre-wrap; overflow-wrap: anywhere; max-width: 340px; max-height: 180px; overflow: auto;
                color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 8px; margin: 4px 0; }
  .review-notes { padding: 9px 11px; color: var(--faint); font-size: 10.5px; border-top: 1px solid var(--border); }

  .kv { font-family: var(--mono); font-size: 12.5px; }
  .kv b { font-weight: 600; }
  .arrow { color: var(--faint); }
  .dimline { color: var(--dim); font-size: 12.5px; }

  .empty { border: 1px dashed var(--border); border-radius: 12px; padding: 36px 24px; text-align: center; color: var(--dim); margin-top: 28px; }
  .empty .kv { display: inline-block; text-align: left; margin-top: 14px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 12px 18px; }
  .banner { display: none; background: color-mix(in srgb, var(--red) 12%, var(--panel)); border: 1px solid color-mix(in srgb, var(--red) 40%, var(--border));
            color: var(--text); border-radius: 8px; padding: 8px 12px; font-size: 12.5px; margin-top: 12px; }
  footer { margin-top: 36px; color: var(--faint); font-size: 11.5px; }
  footer code { font-family: var(--mono); }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="mark" id="mark"><i></i><i></i><i></i><i></i></div>
    <h1>Quilt <span id="repo"></span></h1>
    <div class="head-meta" id="headsha"></div>
    <div class="spacer"></div>
    <div class="counts" id="counts"></div>
    <div class="live" id="live"><span class="pulse"></span><span id="livetext">live</span></div>
  </header>
  <div class="banner" id="banner">Lost contact with quilt ui. Is the command still running? Retrying…</div>
  <main id="main"></main>
  <footer>quilt <span id="ver"></span> · read-only view of <code>.quilt/</code> · refreshes every 2s</footer>
</div>
<script>
(function () {
  "use strict";
  var PALETTE = ["#e06c75","#e5a06b","#e3c46b","#8fc46f","#56c2a8","#5aa9e6","#8a7fe8","#d074c4"];
  var OPEN_REVIEWS = Object.create(null);
  var OPEN_PROMPTS = Object.create(null);
  var REVIEW_CACHE = Object.create(null);
  function colorFor(id) {
    var h = 0;
    for (var i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
    return PALETTE[Math.abs(h) % PALETTE.length];
  }
  // All rendering goes through DOM construction; strings only ever become text
  // nodes, so nothing from the API can be interpreted as markup.
  function el(tag, cls) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    for (var i = 2; i < arguments.length; i++) {
      var kid = arguments[i];
      if (kid == null) continue;
      node.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
    }
    return node;
  }
  function ago(ts) {
    var s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
    if (s < 60) return Math.floor(s) + "s ago";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return Math.floor(s / 86400) + "d ago";
  }
  function chip(id, lines) {
    var swatch = el("i");
    swatch.style.background = colorFor(id);
    var c = el("span", "chip", swatch, id);
    if (lines != null) c.appendChild(el("span", "n", " " + lines));
    return c;
  }
  function badge(kind, text) {
    return el("span", "badge " + kind, text);
  }
  function section(label, sub, cls) {
    var p = el("p", "label", el("b", null, label));
    if (sub) p.appendChild(document.createTextNode(" · " + sub));
    return el("section", cls || null, p);
  }
  function hint(parts) {
    var p = el("p", "hint");
    for (var i = 0; i < parts.length; i++) {
      p.appendChild(i % 2 ? el("code", null, parts[i]) : document.createTextNode(parts[i]));
    }
    return p;
  }

  function renderReviewData(d, panel) {
    panel.replaceChildren();
    if (d.binary) {
      panel.appendChild(el("div", "review-state", "Binary file: line review is unavailable."));
      return;
    }
    d.lines.forEach(function (line, lineIndex) {
      var meta = el("div", "line-meta");
      if (line.actors.length) line.actors.forEach(function (actor) { meta.appendChild(chip(actor)); });
      else if (line.type !== "eq") meta.appendChild(el("span", "un", "unattributed"));
      if (line.conflicted) meta.appendChild(badge("contended", "conflict"));
      line.provenance.forEach(function (p, provenanceIndex) {
        if (!p.prompt) return;
        var details = el("details", "prompt");
        var promptKey = d.path + ":" + lineIndex + ":" + provenanceIndex;
        details.open = !!OPEN_PROMPTS[promptKey];
        details.addEventListener("toggle", function () { OPEN_PROMPTS[promptKey] = details.open; });
        details.appendChild(el("summary", null, "prompt"));
        details.appendChild(el("pre", null, p.prompt));
        meta.appendChild(details);
      });
      var kind = line.type === "add" ? "add" : line.type === "del" ? "del" : "eq";
      var sign = line.type === "add" ? "+" : line.type === "del" ? "−" : " ";
      panel.appendChild(el("div", "diff-line " + kind + (line.conflicted ? " conflict" : ""),
        el("span", "ln", line.oldLineNumber == null ? "" : String(line.oldLineNumber)),
        el("span", "ln", line.newLineNumber == null ? "" : String(line.newLineNumber)),
        el("span", "sign", sign), el("span", "code", line.text), meta));
    });
    panel.appendChild(el("div", "review-notes",
      "Actor means a Quilt session or subagent, not necessarily a person or a single prompt. Prompt matches are inferred by time. " +
      "Local prompts are read only when this panel opens and never leave this server. Claude Code and Codex transcripts are supported; other actors remain per-agent only. Unattributed lines can be legitimate."));
  }

  function loadReview(path, panel) {
    if (REVIEW_CACHE[path]) {
      renderReviewData(REVIEW_CACHE[path], panel);
      return;
    }
    panel.replaceChildren(el("div", "review-state", "Loading local provenance…"));
    fetch("/api/blame?path=" + encodeURIComponent(path)).then(function (r) {
      if (!r.ok) throw new Error("http " + r.status);
      return r.json();
    }).then(function (d) {
      REVIEW_CACHE[path] = d;
      if (OPEN_REVIEWS[path]) renderReviewData(d, panel);
    }).catch(function () {
      panel.replaceChildren(el("div", "review-state", "Could not load this review."));
    });
  }

  function render(d) {
    document.getElementById("repo").textContent = "· " + d.repo;
    document.getElementById("headsha").textContent = d.head;
    document.getElementById("ver").textContent = d.version;
    var marks = document.getElementById("mark").children;
    for (var i = 0; i < marks.length; i++) {
      marks[i].style.background = d.actors.length
        ? colorFor(d.actors[i % d.actors.length].id)
        : "#2a3140";
    }

    var clashes = d.overlaps.filter(function (o) { return o.kind === "contended"; }).length + d.clobbers.length;
    document.getElementById("counts").textContent =
      d.actors.length + (d.actors.length === 1 ? " actor" : " actors") +
      " · " + d.needsYou.length + " needs-you · " + clashes + (clashes === 1 ? " clash" : " clashes") +
      " · " + d.blocked.length + " blocked";

    var main = el("main");

    if (d.needsYou.length) {
      var needs = section("Needs you", "agents couldn\\u2019t reconcile these; your call", "needs");
      var rows = el("div", "rows");
      d.needsYou.forEach(function (o) {
        rows.appendChild(el("div", "card",
          el("span", "row-when", o.actor + " · " + ago(o.ts)),
          el("div", "row-title", "\\u2691 " + o.target),
          o.note ? el("div", "row-sub", o.note) : null));
      });
      needs.appendChild(rows);
      needs.appendChild(hint(["clear with: ", "quilt resolve <target>"]));
      main.appendChild(needs);
    }

    var contended = d.overlaps.filter(function (o) { return o.kind === "contended"; });
    if (d.clobbers.length || contended.length) {
      var clash = section("Clashes", "real collisions; worth your eyes", "clash");
      var crows = el("div", "rows");
      d.clobbers.forEach(function (c) {
        crows.appendChild(el("div", "card",
          el("div", "row-title", "\\u26a0 " + c.path),
          el("div", "row-sub", c.byActor + " overwrote " + c.victimActor + "\\u2019s uncommitted lines; both versions preserved")));
      });
      contended.forEach(function (o) {
        crows.appendChild(el("div", "card",
          el("div", "row-title", "\\u26a0 " + o.path),
          el("div", "row-sub", "same-line clash: " + o.actors.join(", ") + " (" + o.lines + (o.lines === 1 ? " line" : " lines") + ")")));
      });
      clash.appendChild(crows);
      clash.appendChild(hint(["recover: ", "quilt restore <path>", " · back out an actor: ", "quilt undo <actor>"]));
      main.appendChild(clash);
    }

    var actorsSec = section("Actors", null);
    if (d.actors.length === 0) {
      actorsSec.appendChild(el("div", "card idle", "no actors yet"));
    } else {
      var grid = el("div", "actors");
      d.actors.forEach(function (a) {
        var work = a.files.length
          ? a.files.length + (a.files.length === 1 ? " file" : " files") + " in flight"
          : a.claims.length ? "holding claims, no uncommitted edits" : "idle";
        var card = el("div", "card actor",
          el("span", "id", a.id),
          el("span", "type", a.type),
          el("div", a.files.length ? "meta" : "meta idle", work),
          a.claims.length ? el("div", "claims", "claims: " + a.claims.join(", ")) : null);
        card.style.borderTopColor = colorFor(a.id);
        grid.appendChild(card);
      });
      actorsSec.appendChild(grid);
    }
    main.appendChild(actorsSec);

    if (d.files.length) {
      var who = section("Who wrote what", "uncommitted changes by author");
      var table = el("table");
      table.appendChild(el("tr", null, el("th", null, "file"), el("th", null, "authors · lines"), el("th", null, "")));
      d.files.forEach(function (f) {
        var authors = el("td");
        f.actors.forEach(function (a) { authors.appendChild(chip(a.id, a.lines)); });
        if (f.unattributedLines) authors.appendChild(el("span", "un", "+" + f.unattributedLines + " unattributed"));
        if (!f.actors.length && !f.unattributedLines) authors.appendChild(el("span", "un", "unattributed"));
        var badges = el("td");
        if (f.overlap === "contended") badges.appendChild(badge("contended", "clash"));
        else if (f.overlap === "adjacent") badges.appendChild(badge("adjacent", "working close"));
        if (f.isNew) badges.appendChild(badge("new", "new"));
        if (f.isDeleted) badges.appendChild(badge("deleted", "deleted"));
        if (f.binary) badges.appendChild(badge("binary", "binary"));
        var toggle = el("button", "review-toggle" + (OPEN_REVIEWS[f.path] ? " open" : ""), f.path);
        toggle.type = "button";
        toggle.setAttribute("aria-expanded", OPEN_REVIEWS[f.path] ? "true" : "false");
        var fileRow = el("tr", null, el("td", "path", toggle), authors, badges);
        table.appendChild(fileRow);
        var reviewCell = el("td", "review-cell");
        reviewCell.colSpan = 3;
        var reviewPanel = el("div", "review");
        reviewCell.appendChild(reviewPanel);
        var reviewRow = el("tr", null, reviewCell);
        reviewRow.hidden = !OPEN_REVIEWS[f.path];
        table.appendChild(reviewRow);
        toggle.addEventListener("click", function () {
          OPEN_REVIEWS[f.path] = !OPEN_REVIEWS[f.path];
          reviewRow.hidden = !OPEN_REVIEWS[f.path];
          toggle.classList.toggle("open", OPEN_REVIEWS[f.path]);
          toggle.setAttribute("aria-expanded", OPEN_REVIEWS[f.path] ? "true" : "false");
          if (OPEN_REVIEWS[f.path]) loadReview(f.path, reviewPanel);
        });
        if (OPEN_REVIEWS[f.path]) loadReview(f.path, reviewPanel);
      });
      var wrap = el("div", "card", table);
      wrap.style.padding = "2px 0";
      who.appendChild(wrap);
      who.appendChild(hint(["an actor commits exactly its own lines: ", 'quilt commit --mine -m "..."']));
      main.appendChild(who);
    }

    if (d.blocked.length) {
      var blocked = section("Blocked", "denied claims still held by someone else");
      var brows = el("div", "rows");
      d.blocked.forEach(function (b) {
        brows.appendChild(el("div", "card kv",
          "\\u26d4 ", el("b", null, b.actor), el("span", "arrow", " waiting on "), b.target,
          el("span", "arrow", " held by "), b.holder,
          b.holderIntent ? el("div", "dimline", "their intent: " + b.holderIntent) : null));
      });
      blocked.appendChild(brows);
      main.appendChild(blocked);
    }

    if (d.queue.length) {
      var queue = section("Queue", "auto-granted when the target frees");
      var qrows = el("div", "rows");
      d.queue.forEach(function (w) {
        qrows.appendChild(el("div", "card kv",
          "\\u2026 ", el("b", null, w.actor), el("span", "arrow", " queued for "), w.target,
          w.intent ? el("div", "dimline", w.intent) : null));
      });
      queue.appendChild(qrows);
      main.appendChild(queue);
    }

    if (d.dependencyWarnings.length) {
      var deps = section("Dependency heads-up", "a claimed symbol depends on code being changed");
      var drows = el("div", "rows");
      d.dependencyWarnings.forEach(function (w) {
        drows.appendChild(el("div", "card kv",
          "\\u26a0 ", el("b", null, w.yourSymbol), " depends on ", el("b", null, w.dependency),
          ", being changed by ", chip(w.heldBy), el("span", "arrow", " (" + w.heldTarget + ")")));
      });
      deps.appendChild(drows);
      main.appendChild(deps);
    }

    if (d.sewn.length) {
      var sewn = section("Sewn by agents", "recent collisions the agents reconciled themselves");
      var scard = el("div", "card");
      d.sewn.forEach(function (o) {
        scard.appendChild(el("div", "dimline",
          "\\u2713 " + o.target + (o.note ? ": " + o.note : "") + " ",
          el("span", "un", "(" + o.actor + ", " + ago(o.ts) + ")")));
      });
      sewn.appendChild(scard);
      main.appendChild(sewn);
    }

    if (d.unattributed.length) {
      var un = section("Unattributed changes", "pre-existing or generated; no owner recorded");
      var ucard = el("div", "card");
      d.unattributed.forEach(function (p) { ucard.appendChild(el("div", "dimline", p)); });
      un.appendChild(ucard);
      main.appendChild(un);
    }

    if (!d.actors.length && !d.files.length && !d.needsYou.length) {
      var kv = el("div", "kv", "$ quilt setup", el("br"), "$ claude  ", el("span", "un", "# as many terminals as you like"));
      main = el("main", null, el("div", "empty",
        "Nothing on the quilt yet.", el("br"),
        "Start agents in this repo and their work shows up here as it happens.", kv));
    }

    var old = document.getElementById("main");
    main.id = "main";
    old.replaceWith(main);
  }

  function tick() {
    fetch("/api/fleet").then(function (r) {
      if (!r.ok) throw new Error("http " + r.status);
      return r.json();
    }).then(function (d) {
      document.getElementById("banner").style.display = "none";
      document.getElementById("live").classList.remove("stale");
      document.getElementById("livetext").textContent = "live";
      render(d);
    }).catch(function () {
      document.getElementById("banner").style.display = "block";
      document.getElementById("live").classList.add("stale");
      document.getElementById("livetext").textContent = "reconnecting";
    });
  }
  tick();
  setInterval(tick, 2000);
})();
</script>
</body>
</html>
`;
