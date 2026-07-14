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

/** Quote one user-controlled argument for the POSIX shells supported by Quilt. */
export function shellArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

// Keep the copied-command implementation identical in Node tests and the
// self-contained browser client.
const CLIENT_SHELL_ARG = shellArg.toString();

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
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="preconnect" href="https://api.fontshare.com">
<link href="https://api.fontshare.com/v2/css?f[]=gambetta@500,600,700&f[]=switzer@400,500,600&display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
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

  /* Product redesign: one visual system shared with the public site. */
  :root {
    --bg: #f5f5f6; --ink: #1c1c1f; --ink2: #26262a; --ink-sec: #52525b; --ink-mute: #a1a1aa;
    --card: #ffffff; --border: #e4e4e7; --divider: #ececef; --panel: #e8eaef; --panel-border: #d7d8de;
    --caret: #b8b8bf; --footer-dash: #d4d4d8; --link: #4664a6; --sel: rgba(70,100,166,.20);
    --add-bg: #eff4e6; --add-edge: rgba(143,196,111,.7); --add-sign: #4a7a34;
    --del-bg: #f8eae7; --del-edge: rgba(224,108,117,.55); --del-sign: #a83e4c;
    --conflict-edge: #d0596a; --conflict-fg: #a83e4c; --conflict-bg: #f7e0e2; --conflict-border: #e6b0b6;
    --needs-edge: #e0a43a; --needs-fg: #9a7414; --needs-bg: #fbf1d6; --needs-border: #eddba0;
    --clash-fg: #b23a48; --clash-bg: #fbe6e8; --clash-border: #efc0c6;
    --new-fg: #4a7a34; --new-bg: #e9f2e0; --new-border: #c3ddb0;
    --prompt-fg: #176b7a; --prompt-bg: #e4f1f2; --prompt-border: #b9dde0;
    --prompt-panel-bg: #eef6f7; --prompt-panel-border: #cbe4e6; --prompt-label: #5f8a90;
    --text: var(--ink); --dim: var(--ink-sec); --faint: var(--ink-mute); --green: #5aa06a; --red: #c05561; --cyan: var(--prompt-fg);
    --mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    --sans: "Switzer", -apple-system, sans-serif; --display: "Gambetta", Georgia, serif;
  }
  body[data-theme="dark"] {
    --bg: #0e0f13; --ink: #f0f1f4; --ink2: #eceef2; --ink-sec: #a2a8b4; --ink-mute: #868c99;
    --card: #16171d; --border: #262832; --divider: #22242c; --panel: #121319; --panel-border: #262832;
    --caret: #5c616e; --footer-dash: #2c2f3a; --link: #7fa8e0; --sel: rgba(107,182,242,.24);
    --add-bg: rgba(127,216,143,.10); --add-edge: rgba(127,216,143,.7); --add-sign: #7fd88f;
    --del-bg: rgba(242,130,143,.10); --del-edge: rgba(242,130,143,.55); --del-sign: #f2828f;
    --conflict-edge: #e0a43a; --conflict-fg: #f2c46b; --conflict-bg: rgba(224,164,58,.16); --conflict-border: rgba(224,164,58,.45);
    --needs-fg: #f2c877; --needs-bg: rgba(224,164,58,.14); --needs-border: rgba(224,164,58,.4);
    --clash-fg: #f2828f; --clash-bg: rgba(242,130,143,.14); --clash-border: rgba(242,130,143,.4);
    --new-fg: #7fd88f; --new-bg: rgba(127,216,143,.13); --new-border: rgba(127,216,143,.35);
    --prompt-fg: #6fd0d6; --prompt-bg: rgba(80,180,190,.12); --prompt-border: rgba(80,180,190,.32);
    --prompt-panel-bg: #14171c; --prompt-panel-border: #26313a; --prompt-label: #7fa8ad;
  }
  * { box-sizing: border-box; }
  ::selection { background: var(--sel); }
  body { background: var(--bg); color: var(--ink); font: 14px/1.5 var(--sans); -webkit-font-smoothing: antialiased; transition: background .35s ease, color .35s ease; }
  .wrap { max-width: 1180px; padding: 24px 30px 96px; }
  header { gap: 12px; padding: 0; margin-bottom: 26px; }
  .brand-lockup { display: flex; align-items: center; gap: 10px; }
  .mark { grid-template-columns: 10px 10px; gap: 2.5px; padding: 7px; background: var(--card); border: 1px solid var(--border); border-radius: 11px; }
  .mark i { width: 10px; height: 10px; border-radius: 3px; }
  h1 { font-family: var(--display); font-size: 21px; font-weight: 600; letter-spacing: .005em; }
  .repo-chip, .live, .theme-toggle { background: var(--card); border: 1px solid var(--border); border-radius: 8px; color: var(--ink-sec); }
  .repo-chip { display: inline-flex; gap: 7px; padding: 4px 12px; font: 12px var(--mono); }
  .repo-chip #headsha { color: var(--ink-mute); }
  .live { display: inline-flex; align-items: center; gap: 7px; padding: 5px 13px; font-size: 12.5px; }
  .pulse { margin: 0; animation: q-pulse 2.2s ease-in-out infinite; }
  @keyframes q-pulse { 0%,100% { opacity:1 } 50% { opacity:.38 } }
  .theme-toggle { width: 34px; height: 32px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; font-size: 15px; }
  .theme-toggle:active { transform: scale(.94); }
  .counts { display: none; }
  section { margin-top: 0; margin-bottom: 30px; }
  .label { font: 600 11px var(--sans); letter-spacing: .13em; color: var(--ink-mute); margin: 0 0 12px 2px; }
  .label b { color: inherit; }
  .label .section-sub { text-transform: none; letter-spacing: 0; font-weight: 400; }
  .card { background: var(--card); border-color: var(--border); border-radius: 11px; box-shadow: 0 1px 2px rgba(24,24,27,.03); }
  .rows > .card + .card { margin-top: 11px; }
  .priority-card { padding: 0; overflow: hidden; border-radius: 14px; }
  .priority-head { display: flex; align-items: center; gap: 11px; padding: 12px 18px; flex-wrap: wrap; }
  .priority-head.needs-head { background: var(--needs-bg); border-bottom: 1px solid var(--needs-border); }
  .priority-head.clash-head { background: var(--clash-bg); border-bottom: 1px solid var(--clash-border); }
  .priority-icon { width: 18px; height: 18px; border-radius: 50%; background: var(--needs-edge); display: flex; align-items: center; justify-content: center; flex: none; }
  .priority-icon::after { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--card); }
  .priority-icon.clash-icon { width: 15px; height: 15px; border-radius: 3px; transform: rotate(45deg); background: var(--conflict-edge); }
  .priority-icon.clash-icon::after { width: 5px; height: 5px; border-radius: 1px; }
  .priority-kind { font-size: 10.5px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
  .needs-head .priority-kind, .needs-head .priority-meta { color: var(--needs-fg); }
  .clash-head .priority-kind, .clash-head .priority-meta { color: var(--clash-fg); }
  .priority-divider { width: 1px; height: 13px; background: var(--needs-border); }
  .clash-head .priority-divider { background: var(--clash-border); }
  .priority-target { font: 13px var(--mono); color: var(--ink2); word-break: break-all; }
  .priority-meta { margin-left: auto; font-size: 11px; white-space: nowrap; opacity: .85; }
  .priority-body { padding: 15px 18px 16px; }
  .priority-note { color: var(--ink-sec); font-size: 13px; line-height: 1.6; }
  .command-stack { display: grid; gap: 8px; margin-top: 14px; }
  .command { display: flex; align-items: center; gap: 9px; background: var(--panel); border: 1px solid var(--border); border-radius: 9px; padding: 8px 12px; font: 12px var(--mono); color: var(--ink2); }
  .command .prompt-sign { color: var(--needs-edge); font-weight: 700; }
  .command.clash-command .prompt-sign { color: var(--conflict-edge); }
  .command .action { margin-left: auto; font: 10.5px var(--sans); color: var(--ink-mute); text-transform: uppercase; letter-spacing: .08em; }
  .actors { grid-template-columns: repeat(auto-fill,minmax(248px,1fr)); gap: 12px; }
  .actor { border-top: 1px solid var(--border); padding: 14px 15px; }
  .actor-head { display: flex; align-items: center; gap: 10px; }
  .actor-avatar { width: 26px; height: 26px; flex: none; border-radius: 8px; display: flex; align-items: center; justify-content: center; font: 600 12px var(--mono); }
  .actor .id { font-size: 12.5px; line-height: 1.25; }
  .actor .type { display: block; color: var(--ink-mute); font-size: 11px; margin-left: 0; }
  .actor .meta { color: var(--ink-sec); font-size: 12px; margin-top: 10px; }
  .actor .claims { color: var(--ink-sec); font-size: 11px; margin-top: 6px; }
  .filters { margin-left: auto; display: inline-flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .filter-label { color: var(--ink-mute); font-size: 11px; margin-right: 2px; }
  .filter { border: 1px solid var(--border); background: var(--card); color: var(--ink-sec); border-radius: 8px; padding: 4px 12px; font: 500 12px var(--sans); cursor: pointer; }
  .filter[aria-pressed="true"] { background: var(--ink2); color: var(--bg); border-color: var(--ink2); }
  .filter:active { transform: scale(.96); }
  .files-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin: 0 0 14px 2px; }
  .files-head .label { margin: 0; }
  table { background: var(--card); }
  th { display: none; }
  td { border-top-color: var(--divider); padding: 13px 16px; }
  td.path { width: 100%; font-size: 13px; }
  .file-row .authors-cell { white-space: nowrap; text-align: right; }
  .review-toggle { color: var(--ink); display: inline-flex; align-items: center; gap: 9px; }
  .review-toggle::before { content: "▶"; width: auto; font-size: 10px; color: var(--caret); transition: transform .2s cubic-bezier(.23,1,.32,1); }
  .review-toggle.open::before { content: "▶"; transform: rotate(90deg); }
  .chip { background: color-mix(in srgb,var(--chip-color,#a1a1aa) 15%,var(--card)); border-color: color-mix(in srgb,var(--chip-color,#a1a1aa) 40%,var(--card)); border-radius: 8px; color: var(--chip-deep,var(--ink-sec)); padding: 2px 9px 2px 7px; }
  .chip .n { color: inherit; font-weight: 600; }
  .badge { border-radius: 6px; padding: 2px 7px; }
  .badge.contended { color: var(--clash-fg); background: var(--clash-bg); border-color: var(--clash-border); }
  .badge.new { color: var(--new-fg); background: var(--new-bg); border-color: var(--new-border); }
  .files-card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; box-shadow: 0 1px 2px rgba(24,24,27,.03); }
  .review-cell { padding: 0; background: var(--card); border-top: 0; }
  .review { border: 0; border-top: 1px solid var(--border); border-radius: 0; background: var(--card); box-shadow: none; }
  .diff-run-head { display: flex; align-items: center; gap: 8px; min-height: 38px; padding: 6px 10px 6px 106px; border-top: 1px solid var(--divider); background: var(--panel); flex-wrap: wrap; }
  .diff-run-head:first-child { border-top: 0; }
  .run-count { color: var(--ink-mute); font: 11px var(--sans); margin-right: auto; }
  .run-prompt { margin-left: 0; }
  .run-prompt pre { max-width: 560px; }
  .diff-line { grid-template-columns: 44px 44px 16px minmax(0,1fr) auto; border-top-color: var(--divider); color: var(--ink2); }
  .diff-line.add { background: var(--add-bg); box-shadow: inset 3px 0 var(--add-edge); }
  .diff-line.del { background: var(--del-bg); box-shadow: inset 3px 0 var(--del-edge); }
  .diff-line.conflict { box-shadow: inset 3px 0 var(--conflict-edge); }
  .diff-line.add .sign { color: var(--add-sign); }
  .diff-line.del .sign { color: var(--del-sign); }
  .ln { color: var(--caret); }
  .prompt summary { display: inline-flex; align-items: center; gap: 5px; color: var(--prompt-fg); background: var(--prompt-bg); border: 1px solid var(--prompt-border); border-radius: 8px; padding: 2px 10px; }
  .prompt pre { color: var(--ink2); background: var(--prompt-panel-bg); border-color: var(--prompt-panel-border); border-radius: 9px; }
  .review-notes { color: var(--ink-sec); border-top-color: var(--border); line-height: 1.55; }
  .tracking-card { padding: 4px 20px; }
  .tracking-row { display: grid; grid-template-columns: 156px 1fr; gap: 22px; padding: 16px 0; align-items: start; }
  .tracking-row + .tracking-row { border-top: 1px solid var(--divider); }
  .tracking-label { font-size: 11px; text-transform: uppercase; letter-spacing: .09em; color: var(--ink-mute); font-weight: 600; padding-top: 3px; }
  .tracking-items { display: flex; flex-direction: column; gap: 9px; }
  .tracking-item { color: var(--ink-sec); font-size: 13px; }
  .tracking-item b { font: 600 12.5px var(--mono); color: var(--ink2); }
  .tracking-sub { font-size: 12px; margin-top: 2px; }
  .hint { color: var(--ink-mute); margin-top: 11px; }
  .hint code { color: var(--ink-sec); }
  .banner { background: var(--clash-bg); border-color: var(--clash-border); color: var(--ink); }
  footer { margin-top: 40px; border-top: 1px dashed var(--footer-dash); padding-top: 20px; color: var(--ink-mute); display: flex; gap: 10px; flex-wrap: wrap; }

  /* Primary dashboard flow: decisions first, records second. */
  main { min-height: 480px; }
  .view-tabs { display: inline-flex; gap: 3px; padding: 3px; margin: 0 0 28px; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; }
  .view-tab { min-height: 34px; border: 0; border-radius: 7px; padding: 0 15px; background: transparent; color: var(--ink-sec); font: 500 12.5px var(--sans); cursor: pointer; }
  .view-tab[aria-current="page"] { background: var(--card); color: var(--ink); box-shadow: 0 1px 2px rgba(24,24,27,.08); }
  .view-tab:focus-visible, .scope-button:focus-visible, .actor-button:focus-visible, .review-file:focus-visible,
  .review-workspace-button:focus-visible,
  .copy-command:focus-visible, .prompt-trigger:focus-visible, .back-to-top:focus-visible, .change-nav-button:focus-visible,
  .prompt-history-button:focus-visible, .inspector-back:focus-visible, .diff-section-head:focus-visible,
  .review-side-title:focus-visible, .idle-actors summary:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
  .run-summary { display: flex; align-items: stretch; background: var(--card); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; margin-bottom: 30px; }
  .health-block { display: flex; align-items: center; gap: 10px; min-width: 230px; padding: 14px 17px; border-right: 1px solid var(--divider); }
  .health-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--green); box-shadow: 0 0 0 4px color-mix(in srgb,var(--green) 13%,transparent); }
  .health-block.attention .health-dot { background: var(--needs-edge); box-shadow: 0 0 0 4px color-mix(in srgb,var(--needs-edge) 15%,transparent); }
  .health-copy strong { display: block; color: var(--ink2); font-size: 13px; }
  .health-copy span { display: block; color: var(--ink-mute); font-size: 11px; margin-top: 1px; }
  .summary-metrics { display: grid; grid-template-columns: repeat(3,minmax(100px,1fr)); flex: 1; }
  .summary-metric { padding: 12px 17px; }
  .summary-metric + .summary-metric { border-left: 1px solid var(--divider); }
  .summary-metric b { display: block; color: var(--ink2); font: 600 16px var(--mono); }
  .summary-metric span { color: var(--ink-mute); font-size: 11px; }
  .section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin: 0 2px 12px; }
  .section-head .label { margin: 0; }
  .section-note { color: var(--ink-mute); font-size: 11.5px; }
  .attention-list { border: 1px solid var(--needs-border); border-radius: 13px; overflow: hidden; background: var(--card); }
  .attention-item + .attention-item { border-top: 1px solid var(--needs-border); }
  .attention-head { display: flex; align-items: center; gap: 9px; padding: 11px 15px; background: var(--needs-bg); }
  .attention-kind { color: var(--needs-fg); font-size: 10.5px; font-weight: 700; letter-spacing: .11em; text-transform: uppercase; }
  .attention-target { color: var(--ink2); font: 500 12.5px var(--mono); overflow-wrap: anywhere; }
  .attention-meta { margin-left: auto; color: var(--needs-fg); font-size: 11px; }
  .attention-body { padding: 14px 15px 15px; }
  .attention-reason { color: var(--ink-sec); font-size: 13px; line-height: 1.6; max-width: 760px; }
  .intent-pair { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 8px; margin-top: 12px; }
  .intent { padding: 9px 11px; border: 1px solid var(--divider); border-radius: 8px; background: var(--panel); }
  .intent:only-child { grid-column: 1 / -1; }
  .intent span { display: block; color: var(--ink-mute); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; }
  .intent p { margin: 3px 0 0; color: var(--ink-sec); font-size: 12px; }
  .command-stack { margin-top: 12px; }
  .copy-command { width: 100%; min-height: 38px; display: flex; align-items: center; gap: 9px; border: 1px solid var(--border); border-radius: 9px; padding: 8px 11px; background: var(--panel); color: var(--ink2); cursor: pointer; text-align: left; }
  .copy-command code { font: 12px var(--mono); overflow-wrap: anywhere; }
  .copy-command .command-label { margin-left: auto; color: var(--ink-mute); font: 600 10px var(--sans); letter-spacing: .08em; text-transform: uppercase; white-space: nowrap; }
  .copy-command:hover { border-color: var(--panel-border); background: color-mix(in srgb,var(--panel) 72%,var(--card)); }
  .copy-command.copied .command-label { color: var(--new-fg); }
  .actor-list { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; background: var(--card); }
  .actor-row { min-width: 0; padding: 14px 15px; background: var(--card); border: 0; text-align: left; color: inherit; }
  .actor-row:nth-child(even) { border-left: 1px solid var(--divider); }
  .actor-row:nth-child(n+3) { border-top: 1px solid var(--divider); }
  .actor-button { cursor: pointer; }
  .actor-button:hover { background: color-mix(in srgb,var(--panel) 55%,var(--card)); }
  .actor-summary { display: flex; align-items: center; gap: 10px; }
  .actor-main { min-width: 0; flex: 1; }
  .actor-name { display: block; color: var(--ink2); font: 600 12.5px var(--mono); overflow-wrap: anywhere; }
  .actor-kind { display: block; color: var(--ink-mute); font-size: 11px; }
  .actor-state { border-radius: 6px; padding: 2px 7px; color: var(--ink-sec); background: var(--panel); border: 1px solid var(--border); font-size: 10.5px; white-space: nowrap; }
  .actor-state.needs, .actor-state.blocked { color: var(--needs-fg); background: var(--needs-bg); border-color: var(--needs-border); }
  .actor-state.editing { color: var(--new-fg); background: var(--new-bg); border-color: var(--new-border); }
  .actor-detail { margin-top: 10px; color: var(--ink-sec); font-size: 12px; line-height: 1.5; }
  .actor-detail-sub { display: block; margin-top: 3px; color: var(--ink-mute); font-size: 11px; }
  .idle-actors { margin-top: 8px; }
  .idle-actors summary { display: inline-flex; min-height: 34px; align-items: center; color: var(--ink-mute); cursor: pointer; font-size: 12px; list-style: none; }
  .idle-actors summary::-webkit-details-marker { display: none; }
  .idle-actors summary::before { content: "▶"; margin-right: 7px; color: var(--caret); font-size: 9px; transition: transform .15s ease; }
  .idle-actors[open] summary::before { transform: rotate(90deg); }
  .idle-names { display: flex; flex-wrap: wrap; gap: 6px; padding-top: 7px; }
  .idle-name { padding: 4px 8px; background: var(--card); border: 1px solid var(--border); border-radius: 7px; color: var(--ink-mute); font: 11px var(--mono); }
  .review-section-actions { display: flex; align-items: center; gap: 10px; align-self: center; }
  .review-workspace-button { min-height: 34px; border: 1px solid var(--ink2); border-radius: 8px; padding: 5px 11px; background: var(--ink2); color: var(--bg); font: 500 11.5px var(--sans); cursor: pointer; }
  .review-workspace-button:hover { opacity: .84; }
  .review-queue { margin: 0; padding: 0; list-style: none; background: var(--card); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
  .review-row { width: 100%; min-height: 48px; display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-top: 1px solid var(--divider); background: var(--card); color: inherit; }
  .review-row:first-child { border-top: 0; }
  .review-path { min-width: 0; flex: 1; color: var(--ink2); font: 12.5px var(--mono); overflow-wrap: anywhere; }
  .signal-list { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 3px 16px; }
  .signal-row { display: grid; grid-template-columns: 118px 1fr; gap: 16px; padding: 12px 0; color: var(--ink-sec); font-size: 12px; }
  .signal-row + .signal-row { border-top: 1px solid var(--divider); }
  .signal-kind { color: var(--ink-mute); font-size: 10.5px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
  .review-workspace { display: grid; grid-template-columns: 232px minmax(0,1fr) 276px; gap: 12px; align-items: start; scroll-margin-top: 16px; }
  .review-sidebar, .review-stage, .review-inspector { min-width: 0; background: var(--card); border: 1px solid var(--border); border-radius: 12px; }
  .review-sidebar, .review-inspector { overflow: hidden; }
  .review-stage { overflow: clip; }
  .review-sidebar { position: sticky; top: 16px; }
  .review-side-head { padding: 14px; border-bottom: 1px solid var(--divider); }
  .review-side-title { margin: 0; color: var(--ink2); font: 600 17px var(--display); }
  .review-side-sub { margin-top: 2px; color: var(--ink-mute); font-size: 11px; }
  .scope-list { display: flex; gap: 5px; padding: 10px; overflow-x: auto; border-bottom: 1px solid var(--divider); }
  .scope-button { min-height: 30px; border: 1px solid var(--border); border-radius: 7px; padding: 3px 8px; background: var(--card); color: var(--ink-sec); font: 10.5px var(--mono); cursor: pointer; white-space: nowrap; }
  .scope-button[aria-pressed="true"] { color: var(--bg); background: var(--ink2); border-color: var(--ink2); }
  .review-files { padding: 5px; }
  .review-file { width: 100%; min-height: 39px; display: flex; align-items: center; gap: 7px; border: 0; border-radius: 7px; padding: 7px 8px; background: transparent; color: var(--ink-sec); text-align: left; font: 11px var(--mono); cursor: pointer; overflow-wrap: anywhere; }
  .review-file:hover { background: var(--panel); }
  .review-file[aria-current="true"] { background: var(--panel); color: var(--ink2); font-weight: 600; }
  .file-dot { width: 6px; height: 6px; flex: none; border-radius: 2px; background: var(--caret); }
  .review-file.clash .file-dot { background: var(--conflict-edge); }
  .review-file.unowned .file-dot { background: var(--needs-edge); }
  .review-stage-head { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 10px; min-height: 58px; padding: 10px 13px; background: color-mix(in srgb,var(--card) 94%,transparent); border-bottom: 1px solid var(--border); backdrop-filter: blur(10px); }
  .stage-file { min-width: 0; flex: 1; }
  .stage-path { margin: 0; color: var(--ink2); font: 600 12.5px var(--mono); overflow-wrap: anywhere; }
  .stage-meta { margin-top: 3px; color: var(--ink-mute); font-size: 11px; }
  .stage-actions { display: flex; gap: 6px; }
  .stage-actions .copy-command { width: auto; min-height: 32px; padding: 5px 9px; background: var(--ink2); border-color: var(--ink2); color: var(--bg); }
  .stage-actions .copy-command code { display: none; }
  .stage-actions .command-label { margin: 0; color: var(--bg); }
  .stage-actions .copy-command:hover { background: var(--ink); border-color: var(--ink); }
  .review-nav-dock { display: none; position: sticky; top: 58px; z-index: 4; grid-template-columns: 1fr auto 1fr; align-items: center; min-height: 46px; padding: 6px 10px; background: color-mix(in srgb,var(--card) 96%,transparent); border-bottom: 1px solid var(--border); }
  .review-nav-dock.has-tools { display: grid; }
  .change-navigator { display: none; grid-column: 2; align-items: center; overflow: hidden; border: 1px solid var(--border); border-radius: 8px; background: var(--card); }
  .change-navigator.is-ready { display: inline-flex; }
  .change-nav-button { min-width: 88px; min-height: 32px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; border: 0; padding: 4px 9px; background: var(--card); color: var(--ink-sec); font: 500 11px var(--sans); cursor: pointer; }
  .change-nav-button:hover:not([aria-disabled="true"]) { background: var(--panel); color: var(--ink2); }
  .change-nav-button[aria-disabled="true"] { color: var(--ink-mute); cursor: default; }
  .change-nav-status { min-width: 94px; padding: 0 10px; border-left: 1px solid var(--divider); border-right: 1px solid var(--divider); color: var(--ink2); text-align: center; font: 500 10.5px var(--mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .ui-icon { width: 16px; height: 16px; flex: none; }
  .back-to-top { display: none; grid-column: 3; justify-self: end; align-items: center; justify-content: center; gap: 6px; min-height: 32px; border: 1px solid var(--border); border-radius: 8px; padding: 5px 10px; background: var(--card); color: var(--ink-sec); font: 500 11px var(--sans); cursor: pointer; white-space: nowrap; }
  .back-to-top.visible { display: inline-flex; }
  .back-to-top:hover { border-color: var(--panel-border); background: var(--panel); color: var(--ink2); }
  .review-stage .review { border-top: 0; }
  .diff-section-head { min-height: 32px; display: flex; align-items: center; gap: 7px; margin: 0; padding: 6px 10px 6px 106px; scroll-margin-top: 108px; border-top: 1px solid var(--border); border-bottom: 1px solid var(--divider); background: color-mix(in srgb,var(--panel) 66%,var(--card)); color: var(--ink-sec); font: 500 10.5px var(--mono); }
  .diff-section-head:first-child { border-top: 0; }
  .diff-section-head b { color: var(--ink2); font-weight: 600; }
  .review-inspector { position: sticky; top: 16px; max-height: calc(100vh - 32px); overflow: auto; }
  .inspector-head { min-height: 47px; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 14px; border-bottom: 1px solid var(--divider); background: var(--card); }
  .inspector-title { margin: 0; color: var(--ink2); font: 600 14px var(--display); }
  .inspector-close { min-height: 28px; border: 1px solid var(--border); border-radius: 7px; padding: 3px 8px; background: var(--panel); color: var(--ink-sec); font: 500 10.5px var(--sans); cursor: pointer; }
  .inspector-close:hover { border-color: var(--panel-border); color: var(--ink2); }
  .inspector-body { padding: 14px; }
  .inspector-kicker { color: var(--prompt-label); font-size: 10px; font-weight: 600; letter-spacing: .09em; text-transform: uppercase; }
  .inspector-copy { margin: 6px 0 0; color: var(--ink-sec); font-size: 12px; line-height: 1.55; }
  .inspector-prompt { max-height: 390px; overflow: auto; margin: 10px 0 0; padding: 11px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--ink2); background: var(--prompt-panel-bg); border: 1px solid var(--prompt-panel-border); border-radius: 9px; font: 11px/1.55 var(--mono); }
  .inspector-note { margin-top: 10px; color: var(--ink-mute); font-size: 10.5px; line-height: 1.5; }
  .prompt-trigger { min-height: 28px; display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--prompt-border); border-radius: 7px; padding: 3px 8px; background: var(--prompt-bg); color: var(--prompt-fg); font: 500 10.5px var(--sans); cursor: pointer; white-space: nowrap; transition: background .14s ease-out, border-color .14s ease-out, color .14s ease-out; }
  .prompt-trigger:hover { border-color: var(--prompt-fg); }
  .prompt-trigger[aria-expanded="true"] { border-color: var(--prompt-fg); background: var(--prompt-fg); color: var(--card); }
  .prompt-history-list { display: grid; gap: 7px; margin: 11px 0 0; padding: 0; list-style: none; }
  .prompt-history-button { width: 100%; display: grid; grid-template-columns: 22px minmax(0,1fr); gap: 8px; padding: 9px; border: 1px solid var(--divider); border-radius: 8px; background: var(--card); color: inherit; text-align: left; cursor: pointer; }
  .prompt-history-button:hover { border-color: var(--prompt-border); background: var(--prompt-panel-bg); }
  .prompt-history-index { color: var(--prompt-fg); font: 600 10px var(--mono); padding-top: 1px; }
  .prompt-history-summary { display: -webkit-box; overflow: hidden; -webkit-line-clamp: 2; -webkit-box-orient: vertical; color: var(--ink2); font-size: 11.5px; line-height: 1.4; }
  .prompt-history-meta { display: block; margin-top: 4px; color: var(--ink-sec); font: 10px var(--mono); }
  .inspector-back { min-height: 30px; margin-bottom: 11px; border: 0; padding: 0; background: transparent; color: var(--prompt-fg); font: 500 11px var(--sans); cursor: pointer; }
  .prompt-detail-meta { margin-top: 6px; color: var(--ink-sec); font: 10.5px var(--mono); }
  .prompt-backdrop { display: none; }
  .review-empty { min-height: 330px; display: flex; align-items: center; justify-content: center; padding: 30px; color: var(--ink-mute); text-align: center; }
  .freshness { font-variant-numeric: tabular-nums; }
  @media (max-width: 820px) {
    .wrap { padding: 18px 18px 72px; }
    .tracking-row { grid-template-columns: 1fr; gap: 7px; }
    .file-row { display: flex; flex-direction: column; }
    .file-row .authors-cell { text-align: left; padding-top: 0; }
    .diff-line { grid-template-columns: 34px 34px 14px minmax(0,1fr); }
    .line-meta { grid-column: 4; text-align: left; padding-left: 2px; }
    .run-summary { display: block; }
    .health-block { border-right: 0; border-bottom: 1px solid var(--divider); }
    .summary-metrics { grid-template-columns: repeat(3,1fr); }
    .summary-metric { padding: 10px 12px; }
    .actor-list { grid-template-columns: 1fr; }
    .actor-row:nth-child(even) { border-left: 0; }
    .actor-row:nth-child(n+2) { border-top: 1px solid var(--divider); }
    .intent-pair { grid-template-columns: 1fr; }
    .review-section-actions { flex-wrap: wrap; justify-content: flex-end; }
    .review-workspace { grid-template-columns: 1fr; }
    .review-sidebar { position: static; }
    .review-files { display: flex; gap: 5px; overflow-x: auto; }
    .review-file { width: auto; min-width: 180px; }
    .review-stage-head { position: static; }
    .review-nav-dock { position: fixed; left: 12px; right: 12px; bottom: max(12px,env(safe-area-inset-bottom)); top: auto; z-index: 20; min-height: 52px; padding: 4px; border: 1px solid var(--border); border-radius: 11px; background: var(--card); box-shadow: 0 12px 34px rgba(24,24,27,.18); }
    .review-nav-dock.has-tools { display: flex; justify-content: center; gap: 4px; }
    .review-nav-dock.prompt-obscured { visibility: hidden; opacity: 0; pointer-events: none; }
    .review-nav-dock.back-only { left: 50%; right: auto; width: max-content; min-height: 0; padding: 0; transform: translateX(-50%); border: 0; background: transparent; box-shadow: none; }
    .review-nav-dock.back-only .back-to-top { box-shadow: 0 12px 34px rgba(24,24,27,.22); }
    .change-navigator { min-width: 0; flex: 1; justify-content: center; border: 0; }
    .change-nav-button { min-width: 0; min-height: 44px; flex: 1; padding: 6px 8px; }
    .change-nav-status { min-width: 88px; }
    .back-to-top { min-height: 44px; justify-self: auto; padding: 8px 11px; border-color: var(--ink2); background: var(--ink2); color: var(--bg); }
    .back-to-top.visible { display: inline-flex; }
    .back-to-top:hover { border-color: var(--ink); background: var(--ink); color: var(--bg); }
    .diff-section-head { padding-left: 82px; scroll-margin-top: 12px; }
    .review-inspector { position: fixed; left: 12px; right: 12px; top: auto; bottom: max(12px,env(safe-area-inset-bottom)); z-index: 30; max-height: min(68dvh,520px); overflow: auto; visibility: hidden; opacity: 0; pointer-events: none; transform: translateY(calc(100% + 24px)); box-shadow: 0 22px 70px rgba(24,24,27,.24); transition: transform .2s cubic-bezier(.22,1,.36,1), opacity .14s ease-out, visibility 0s linear .2s; }
    .review-inspector.has-prompt { visibility: visible; opacity: 1; pointer-events: auto; transform: translateY(0); transition-delay: 0s; }
    .review-inspector .inspector-head { position: sticky; top: 0; z-index: 1; }
    .review-inspector .inspector-prompt { max-height: none; overflow: visible; }
    .prompt-trigger, .inspector-close, .prompt-history-button { min-height: 44px; }
    .prompt-backdrop.visible { display: block; position: fixed; inset: 0; z-index: 29; background: rgba(14,15,19,.28); }
    body.prompt-dialog-open { overflow: hidden; }
  }
  @media (max-width: 380px) {
    .review-nav-dock .change-nav-button > span,
    .review-nav-dock .back-to-top > span { display: none; }
    .review-nav-dock .change-nav-button,
    .review-nav-dock .back-to-top { width: 44px; min-width: 44px; flex: none; padding: 0; }
    .review-nav-dock .change-nav-status { min-width: 80px; }
  }
  @media (prefers-reduced-motion: reduce) { .pulse { animation: none; } body, .prompt-trigger, .review-inspector, .review-nav-dock { transition: none; } }
</style>
</head>
<body data-theme="light">
<div class="wrap">
  <header>
    <div class="brand-lockup">
      <div class="mark" id="mark"><i></i><i></i><i></i><i></i></div>
      <h1>Quilt</h1>
    </div>
    <div class="repo-chip"><span id="repo"></span><span id="headsha"></span></div>
    <div class="spacer"></div>
    <div class="counts" id="counts"></div>
    <div class="live" id="live"><span class="pulse"></span><span id="livetext">live</span></div>
    <button class="theme-toggle" id="theme-toggle" type="button" aria-label="Switch to dark theme" title="Switch theme">☾</button>
  </header>
  <div class="banner" id="banner">Lost contact with quilt ui. Is the command still running? Retrying…</div>
  <main id="main"></main>
  <footer><span>quilt <code id="ver"></code></span><span>·</span><span>read-only view of <code>.quilt/</code></span><span>·</span><span>refreshes every 2s</span><span>·</span><span>local-only · 127.0.0.1</span></footer>
</div>
<script>
(function () {
  "use strict";
  ${CLIENT_SHELL_ARG}
  var PALETTE = ["#e06c75","#e5a06b","#e3c46b","#8fc46f","#56c2a8","#5aa9e6","#8a7fe8","#d074c4"];
  var REVIEW_CACHE = Object.create(null);
  var ACTIVE_VIEW = "overview";
  var ACTIVE_FILTER = null;
  var SELECTED_FILE = null;
  var PROMPT_CONTEXT = null;
  var LAST_DATA = null;
  var LAST_SIGNATURE = null;
  var LAST_UPDATED_AT = 0;
  var REVIEW_SCROLL_FRAME = null;
  var REVIEW_REQUEST_ID = 0;
  var REVIEW_REQUEST_BY_PATH = Object.create(null);
  var REVIEW_CACHE_SIGNATURE = Object.create(null);
  function colorFor(id) {
    var h = 0;
    for (var i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
    return PALETTE[Math.abs(h) % PALETTE.length];
  }
  function deepFor(id) {
    var c = colorFor(id).toLowerCase();
    var deep = { "#5aa9e6":"#2f6d9e", "#d074c4":"#9c3f90", "#8fc46f":"#4a7a34", "#e5a06b":"#a5651f", "#e06c75":"#a83e4c" };
    return document.body.dataset.theme === "dark" ? c : (deep[c] || "var(--ink-sec)");
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
  function uiIcon(name) {
    var paths = {
      "arrow-up": ["M12 5v14m6-8l-6-6m-6 6l6-6"],
      "arrow-down": ["M12 5v14m6-6l-6 6m-6-6l6 6"],
      "history": ["M12 8v4l2 2", "M3.05 11a9 9 0 1 1 .5 4m-.5 5v-5h5"],
      "arrow-bar-to-up": ["M12 10v10m0-10l4 4m-4-4l-4 4M4 4h16"],
    };
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.setAttribute("class", "ui-icon");
    (paths[name] || []).forEach(function (pathData) {
      var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", pathData);
      svg.appendChild(path);
    });
    return svg;
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
    c.style.setProperty("--chip-color", colorFor(id));
    c.style.setProperty("--chip-deep", deepFor(id));
    if (lines != null) c.appendChild(el("span", "n", " " + lines));
    return c;
  }
  function badge(kind, text) {
    return el("span", "badge " + kind, text);
  }
  function section(label, sub, cls) {
    var heading = el("h2", "label", label);
    var head = el("div", "section-head", heading, sub ? el("span", "section-note", sub) : null);
    return el("section", cls || null, head);
  }
  function hint(parts) {
    var p = el("p", "hint");
    for (var i = 0; i < parts.length; i++) {
      p.appendChild(i % 2 ? el("code", null, parts[i]) : document.createTextNode(parts[i]));
    }
    return p;
  }

  function setFocusKey(node, key) {
    node.setAttribute("data-focus-key", key);
    return node;
  }
  function restoreFocus(key) {
    if (!key) return;
    var nodes = document.querySelectorAll("[data-focus-key]");
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].getAttribute("data-focus-key") === key) {
        try { nodes[i].focus({ preventScroll: true }); } catch (e) { nodes[i].focus(); }
        return;
      }
    }
  }
  function activeFocusKey() {
    return document.activeElement && document.activeElement.getAttribute
      ? document.activeElement.getAttribute("data-focus-key") : null;
  }
  function scrollReviewWorkspaceToTop(animate, moveFocus) {
    var workspace = document.getElementById("review-workspace");
    if (!workspace) return;
    var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    try {
      workspace.scrollIntoView({ behavior: animate && !reducedMotion ? "smooth" : "auto", block: "start" });
    } catch (e) {
      workspace.scrollIntoView(true);
    }
    if (moveFocus) restoreFocus("review-top");
  }
  function changeHeadings() {
    return document.querySelectorAll("#review-diff .diff-section-head");
  }
  function updateChangeNavigator(index, announce) {
    var navigatorNode = document.getElementById("review-change-navigator");
    if (!navigatorNode || !navigatorNode.classList.contains("is-ready")) return;
    var headings = changeHeadings();
    if (!headings.length) return;
    var safeIndex = Math.max(0, Math.min(index, headings.length - 1));
    navigatorNode.setAttribute("data-change-index", String(safeIndex));
    var previous = document.getElementById("review-change-previous");
    var next = document.getElementById("review-change-next");
    var status = document.getElementById("review-change-status");
    if (previous) previous.setAttribute("aria-disabled", safeIndex === 0 ? "true" : "false");
    if (next) next.setAttribute("aria-disabled", safeIndex === headings.length - 1 ? "true" : "false");
    if (status) status.textContent = "Change " + (safeIndex + 1) + " of " + headings.length;
    if (announce) {
      var live = document.getElementById("review-change-live");
      if (live) live.textContent = "Moved to " + headings[safeIndex].getAttribute("aria-label");
    }
  }
  function currentChangeIndex() {
    var headings = changeHeadings();
    if (!headings.length) return 0;
    var documentHeight = document.documentElement.scrollHeight;
    if (documentHeight > window.innerHeight && window.scrollY > 0
      && window.scrollY + window.innerHeight >= documentHeight - 4) {
      return headings.length - 1;
    }
    var dock = document.getElementById("review-nav-dock");
    var narrow = window.matchMedia("(max-width: 820px)").matches;
    var anchor = 12;
    if (!narrow) {
      var stageHead = document.querySelector(".review-stage-head");
      anchor = (stageHead ? stageHead.getBoundingClientRect().bottom : 58)
        + (dock ? dock.getBoundingClientRect().height : 0) + 8;
    }
    var active = 0;
    for (var i = 0; i < headings.length; i++) {
      if (headings[i].getBoundingClientRect().top <= anchor) active = i;
      else break;
    }
    return active;
  }
  function configureChangeNavigator(count, panel) {
    var navigatorNode = panel && panel.parentNode
      ? panel.parentNode.querySelector("#review-change-navigator")
      : null;
    if (!navigatorNode) navigatorNode = document.getElementById("review-change-navigator");
    if (!navigatorNode) return;
    navigatorNode.classList.toggle("is-ready", count > 1);
    navigatorNode.setAttribute("aria-hidden", count > 1 ? "false" : "true");
    if (count > 1) {
      navigatorNode.setAttribute("data-change-index", "0");
      var previous = navigatorNode.querySelector("#review-change-previous");
      var next = navigatorNode.querySelector("#review-change-next");
      var status = navigatorNode.querySelector("#review-change-status");
      if (previous) previous.setAttribute("aria-disabled", "true");
      if (next) next.setAttribute("aria-disabled", count === 1 ? "true" : "false");
      if (status) status.textContent = "Change 1 of " + count;
      if (navigatorNode.isConnected) updateChangeNavigator(0, false);
    }
    scheduleReviewScrollSync();
  }
  function goToChange(delta) {
    var navigatorNode = document.getElementById("review-change-navigator");
    if (!navigatorNode || !navigatorNode.classList.contains("is-ready")) return false;
    var headings = changeHeadings();
    if (!headings.length) return false;
    var current = Number(navigatorNode.getAttribute("data-change-index") || currentChangeIndex());
    var targetIndex = Math.max(0, Math.min(current + delta, headings.length - 1));
    if (targetIndex === current) return false;
    try { headings[targetIndex].scrollIntoView({ behavior: "auto", block: "start" }); }
    catch (e) { headings[targetIndex].scrollIntoView(true); }
    updateChangeNavigator(targetIndex, true);
    return true;
  }
  function syncReviewNavigation() {
    var button = document.getElementById("review-back-to-top");
    var dock = document.getElementById("review-nav-dock");
    var workspace = document.getElementById("review-workspace");
    var stage = document.getElementById("review-stage");
    var panel = document.getElementById("review-diff");
    if (!button || !dock || !workspace || !stage || !panel) return;
    var narrow = window.matchMedia("(max-width: 820px)").matches;
    var main = document.getElementById("main");
    // Escape the clipped stage on narrow layouts so the fixed dock remains
    // viewport-relative; return it between the sticky file head and diff on wide layouts.
    if (narrow && main && dock.parentNode !== main) main.appendChild(dock);
    else if (!narrow && dock.parentNode !== stage) stage.insertBefore(dock, panel);
    var workspaceBox = workspace.getBoundingClientRect();
    var stageBox = stage.getBoundingClientRect();
    var promptSheetOpen = narrow && Boolean(document.querySelector(".review-inspector.has-prompt"));
    var backVisible = ACTIVE_VIEW === "review"
      && stageBox.height > window.innerHeight + 160
      && workspaceBox.top < -480
      && stageBox.bottom > 96
      && !promptSheetOpen;
    button.classList.toggle("visible", backVisible);
    button.tabIndex = backVisible ? 0 : -1;
    button.setAttribute("aria-hidden", backVisible ? "false" : "true");
    var navigatorNode = document.getElementById("review-change-navigator");
    var navigatorVisible = Boolean(navigatorNode && navigatorNode.classList.contains("is-ready"));
    dock.classList.toggle("has-tools", navigatorVisible || backVisible);
    dock.classList.toggle("back-only", backVisible && !navigatorVisible);
    dock.classList.toggle("prompt-obscured", promptSheetOpen);
    if (navigatorVisible) updateChangeNavigator(currentChangeIndex(), false);
  }
  function scheduleReviewScrollSync() {
    if (REVIEW_SCROLL_FRAME !== null) return;
    REVIEW_SCROLL_FRAME = window.requestAnimationFrame(function () {
      REVIEW_SCROLL_FRAME = null;
      syncReviewNavigation();
    });
  }
  function contributorIds(d) {
    var ids = {};
    d.files.forEach(function (file) { file.actors.forEach(function (actor) { ids[actor.id] = true; }); });
    return Object.keys(ids);
  }
  function filesForScope(d) {
    return d.files.filter(function (file) {
      return !ACTIVE_FILTER || file.actors.some(function (actor) { return actor.id === ACTIVE_FILTER; });
    });
  }
  function actorState(d, actor) {
    var needs = d.needsYou.find(function (item) { return item.actor === actor.id; });
    var blocked = d.blocked.find(function (item) { return item.actor === actor.id; });
    var queued = d.queue.find(function (item) { return item.actor === actor.id; });
    if (needs) return { key: "needs", label: "Needs you", detail: needs.note || "Waiting for a human decision", sub: needs.target, engaged: true };
    if (blocked) return { key: "blocked", label: "Blocked", detail: "Waiting on " + blocked.target, sub: "Held by " + blocked.holder + (blocked.holderIntent ? ": " + blocked.holderIntent : ""), engaged: true };
    if (queued) return { key: "queued", label: "Queued", detail: "Next for " + queued.target, sub: queued.intent || "Auto-grants when the target is released", engaged: true };
    if (actor.files.length) return { key: "editing", label: "Editing", detail: actor.files.length + (actor.files.length === 1 ? " file in flight" : " files in flight"), sub: actor.claims.length ? "Claims: " + actor.claims.join(", ") : null, engaged: true };
    if (actor.claims.length) return { key: "claimed", label: "Holding claim", detail: actor.claims.join(", "), sub: "No uncommitted edits yet", engaged: true };
    return { key: "idle", label: "Idle", detail: "No current work", sub: null, engaged: false };
  }
  function copyText(text, button) {
    function done() {
      button.classList.add("copied");
      var label = button.querySelector(".command-label");
      if (label) label.textContent = "copied";
      setTimeout(function () {
        button.classList.remove("copied");
        if (label) label.textContent = "copy command";
      }, 1400);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () { fallback(); });
    } else fallback();
    function fallback() {
      var area = el("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      try { document.execCommand("copy"); done(); } catch (e) {}
      area.remove();
    }
  }
  function commandButton(command, compact) {
    var button = el("button", "copy-command",
      el("span", "prompt-sign", "›"), el("code", null, command),
      el("span", "command-label", compact || "copy command"));
    button.type = "button";
    button.setAttribute("aria-label", "Copy command: " + command);
    button.addEventListener("click", function () { copyText(command, button); });
    return button;
  }
  function switchView(view, focusKey) {
    var enteringReview = view === "review" && ACTIVE_VIEW !== "review";
    ACTIVE_VIEW = view;
    PROMPT_CONTEXT = null;
    if (LAST_DATA) {
      render(LAST_DATA, focusKey);
      if (enteringReview) scrollReviewWorkspaceToTop(false, false);
    }
  }
  function viewTabs() {
    var nav = el("nav", "view-tabs");
    nav.setAttribute("aria-label", "Dashboard views");
    ["overview", "review"].forEach(function (view) {
      var button = setFocusKey(el("button", "view-tab", view === "overview" ? "Overview" : "Review"), "view:" + view);
      button.type = "button";
      if (ACTIVE_VIEW === view) button.setAttribute("aria-current", "page");
      button.addEventListener("click", function () { switchView(view, "view:" + view); });
      nav.appendChild(button);
    });
    return nav;
  }

  function syncPromptTriggers(activeKey) {
    var triggers = document.querySelectorAll(".prompt-trigger");
    for (var i = 0; i < triggers.length; i++) {
      var trigger = triggers[i];
      var active = Boolean(activeKey && trigger.getAttribute("data-prompt-key") === activeKey);
      trigger.setAttribute("aria-expanded", active ? "true" : "false");
    }
  }

  function syncPromptModalState(active) {
    var modalActive = Boolean(active);
    var backdrop = document.getElementById("review-prompt-backdrop");
    if (backdrop) backdrop.classList.toggle("visible", modalActive);
    document.body.classList.toggle("prompt-dialog-open", modalActive);
    var backgrounds = document.querySelectorAll(
      "header, #banner, .view-tabs, .review-sidebar, .review-stage, .review-nav-dock, footer"
    );
    for (var i = 0; i < backgrounds.length; i++) {
      if (modalActive) backgrounds[i].setAttribute("inert", "");
      else backgrounds[i].removeAttribute("inert");
    }
  }

  function syncPromptPresentation() {
    var inspector = document.getElementById("review-inspector");
    var modalActive = Boolean(inspector && inspector.classList.contains("has-prompt")
      && window.matchMedia("(max-width: 820px)").matches);
    if (inspector && modalActive) {
      inspector.setAttribute("role", "dialog");
      inspector.setAttribute("aria-modal", "true");
    } else if (inspector) {
      inspector.removeAttribute("role");
      inspector.removeAttribute("aria-modal");
    }
    syncPromptModalState(modalActive);
  }

  function closePromptContext(reviewData, returnFocus) {
    if (!PROMPT_CONTEXT) return;
    var returnKey = PROMPT_CONTEXT.originKey;
    PROMPT_CONTEXT = null;
    syncPromptTriggers(null);
    renderInspector(null, reviewData || (SELECTED_FILE ? REVIEW_CACHE[SELECTED_FILE] : null));
    if (returnFocus !== false) restoreFocus("prompt:" + returnKey);
  }

  function focusInspectorHeading(context) {
    if (!context) return;
    restoreFocus("prompt-inspector:" + context.originKey);
  }

  function providerLabel(provider) {
    var value = provider || "agent";
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  function promptSummary(prompt) {
    var lines = String(prompt || "").split("\\n");
    var marker = -1;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].trim().toLowerCase() === "## my request for codex:") { marker = i; break; }
    }
    var source = marker >= 0 ? lines.slice(marker + 1) : lines;
    var kept = [];
    var insideAmbient = false;
    source.forEach(function (line) {
      var trimmed = line.trim();
      if (trimmed.indexOf("<in-app-browser-context") === 0) { insideAmbient = true; return; }
      if (insideAmbient && trimmed.indexOf("</in-app-browser-context>") === 0) { insideAmbient = false; return; }
      if (insideAmbient || !trimmed || trimmed.indexOf("<image ") === 0 || trimmed.indexOf("</image>") === 0) return;
      if (trimmed === "# Files mentioned by the user:" || trimmed.indexOf("## Screenshot ") === 0) return;
      kept.push(trimmed.replace(/^#+\\s*/, ""));
    });
    var summary = kept.join(" ").replace(/\\s+/g, " ").trim();
    if (!summary) summary = "Prompt context";
    return summary.length > 76 ? summary.slice(0, 73).trimEnd() + "…" : summary;
  }

  function promptTimeLabel(provenance) {
    if (!provenance.promptTs) return null;
    var date = new Date(provenance.promptTs);
    if (!Number.isFinite(date.getTime())) return null;
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function promptEntryMeta(entry) {
    var parts = [providerLabel(entry.provenance.provider),
      entry.changedLines + (entry.changedLines === 1 ? " changed line" : " changed lines")];
    var time = promptTimeLabel(entry.provenance);
    if (time) parts.push(time);
    return parts.join(" · ");
  }

  function collectPromptEntries(lines, start, end) {
    var byKey = Object.create(null);
    var entries = [];
    for (var lineIndex = start; lineIndex < end; lineIndex++) {
      var countedOnLine = Object.create(null);
      lines[lineIndex].provenance.forEach(function (provenance) {
        if (!provenance.prompt) return;
        var key = provenance.promptTs
          ? (provenance.actor || "") + "\u0000" + (provenance.sessionId || "") + "\u0000" + provenance.promptTs
          : (provenance.provider || "agent") + "\u0000" + provenance.prompt;
        var entry = byKey[key];
        if (!entry) {
          entry = { key: key, provenance: provenance, summary: promptSummary(provenance.prompt), changedLines: 0, order: entries.length };
          byKey[key] = entry;
          entries.push(entry);
        }
        if (lines[lineIndex].type !== "eq" && !countedOnLine[key]) {
          entry.changedLines += 1;
          countedOnLine[key] = true;
        }
      });
    }
    entries.sort(function (a, b) {
      var aTime = a.provenance.promptTs ? Date.parse(a.provenance.promptTs) : NaN;
      var bTime = b.provenance.promptTs ? Date.parse(b.provenance.promptTs) : NaN;
      var aValid = Number.isFinite(aTime);
      var bValid = Number.isFinite(bTime);
      if (aValid && bValid && aTime !== bTime) return aTime - bTime;
      if (aValid !== bValid) return aValid ? -1 : 1;
      return a.order - b.order;
    });
    return entries;
  }

  function renderInspector(context, reviewData) {
    var inspector = document.getElementById("review-inspector");
    if (!inspector) {
      syncPromptModalState(false);
      return;
    }
    var hasPrompt = Boolean(context && context.entries && context.entries.length);
    inspector.classList.toggle("has-prompt", hasPrompt);
    inspector.setAttribute("aria-labelledby", "review-inspector-title");
    var body = el("div", "inspector-body");
    var titleText = "Context";
    if (hasPrompt) titleText = context.mode === "history"
      ? "Prompt history"
      : (context.entries.length > 1 ? "Prompt " + (context.activeIndex + 1) + " of " + context.entries.length : "Prompt context");
    var title = el("h2", "inspector-title", titleText);
    title.id = "review-inspector-title";
    if (hasPrompt) {
      setFocusKey(title, "prompt-inspector:" + context.originKey);
      title.tabIndex = -1;
    }
    var head = el("div", "inspector-head", title);
    if (hasPrompt) {
      if (context.mode === "history") {
        body.appendChild(el("div", "inspector-kicker", context.entries.length + " prompts"));
        body.appendChild(el("p", "inspector-copy", context.label + ". Choose a prompt to inspect its full local context."));
        var list = el("ol", "prompt-history-list");
        context.entries.forEach(function (entry, index) {
          var button = setFocusKey(el("button", "prompt-history-button",
            el("span", "prompt-history-index", String(index + 1)),
            el("span", null, el("span", "prompt-history-summary", entry.summary),
              el("span", "prompt-history-meta", promptEntryMeta(entry)))),
          "prompt-history:" + context.originKey + ":" + index);
          button.type = "button";
          button.setAttribute("data-history-index", String(index));
          button.setAttribute("aria-label", "Prompt " + (index + 1) + " of " + context.entries.length + ": " + entry.summary + ", " + promptEntryMeta(entry));
          button.addEventListener("click", function () {
            PROMPT_CONTEXT = { mode: "detail", originKey: context.originKey, entries: context.entries,
              activeIndex: index, label: context.label };
            renderInspector(PROMPT_CONTEXT, reviewData);
            focusInspectorHeading(PROMPT_CONTEXT);
          });
          list.appendChild(el("li", null, button));
        });
        body.appendChild(list);
      } else {
        var activeIndex = Math.max(0, Math.min(context.activeIndex || 0, context.entries.length - 1));
        var entry = context.entries[activeIndex];
        if (context.entries.length > 1) {
          var back = el("button", "inspector-back", "Back to prompt history");
          back.type = "button";
          back.addEventListener("click", function () {
            var priorIndex = activeIndex;
            PROMPT_CONTEXT = { mode: "history", originKey: context.originKey, entries: context.entries,
              activeIndex: priorIndex, label: context.label };
            renderInspector(PROMPT_CONTEXT, reviewData);
            restoreFocus("prompt-history:" + context.originKey + ":" + priorIndex);
          });
          body.appendChild(back);
        }
        body.appendChild(el("div", "inspector-kicker", providerLabel(entry.provenance.provider) + " prompt"));
        body.appendChild(el("p", "inspector-copy", context.label));
        body.appendChild(el("div", "prompt-detail-meta", promptEntryMeta(entry)));
        var prompt = el("pre", "inspector-prompt", entry.provenance.prompt);
        prompt.tabIndex = 0;
        prompt.setAttribute("aria-label", "Full prompt text");
        body.appendChild(prompt);
      }
      body.appendChild(el("p", "inspector-note",
        "Prompt matching is inferred by time. This transcript stays local and is not written into Git history."));
      var close = setFocusKey(el("button", "inspector-close", "Close"), "prompt-close:" + context.originKey);
      close.type = "button";
      close.setAttribute("aria-label", "Close prompt context");
      close.addEventListener("click", function () {
        closePromptContext(reviewData, true);
      });
      head.appendChild(close);
    } else {
      var actors = {};
      if (reviewData && reviewData.lines) reviewData.lines.forEach(function (line) {
        line.actors.forEach(function (actor) { actors[actor] = true; });
      });
      body.appendChild(el("div", "inspector-kicker", "Provenance"));
      body.appendChild(el("p", "inspector-copy",
        Object.keys(actors).length
          ? "Select a prompt marker in the diff to inspect the local context without moving the code."
          : "This file has no attributed prompt context to inspect."));
      Object.keys(actors).forEach(function (actor) { body.appendChild(chip(actor)); });
      body.appendChild(el("p", "inspector-note",
        "Actors are Quilt sessions or subagent runs. Unattributed changes can be generated or pre-existing."));
    }
    inspector.replaceChildren(head, body);
    syncPromptPresentation();
    scheduleReviewScrollSync();
  }

  function promptControl(entries, label, key, reviewData) {
    if (!entries.length) return null;
    var active = Boolean(PROMPT_CONTEXT && PROMPT_CONTEXT.originKey === key);
    var idleLabel = entries.length === 1 ? "View prompt" : "Prompt history (" + entries.length + ")";
    var button = setFocusKey(el("button", "prompt-trigger"), "prompt:" + key);
    if (entries.length > 1) button.appendChild(uiIcon("history"));
    button.appendChild(document.createTextNode(idleLabel));
    button.type = "button";
    button.setAttribute("data-prompt-key", key);
    button.setAttribute("aria-expanded", active ? "true" : "false");
    button.setAttribute("aria-controls", "review-inspector");
    button.setAttribute("aria-label", idleLabel + " for " + label);
    button.addEventListener("click", function () {
      if (PROMPT_CONTEXT && PROMPT_CONTEXT.originKey === key) {
        closePromptContext(reviewData, false);
        return;
      }
      PROMPT_CONTEXT = { mode: entries.length > 1 ? "history" : "detail", originKey: key,
        entries: entries, activeIndex: 0, label: label };
      syncPromptTriggers(key);
      renderInspector(PROMPT_CONTEXT, reviewData);
      focusInspectorHeading(PROMPT_CONTEXT);
    });
    return button;
  }

  function reviewSections(reviewData) {
    if (Array.isArray(reviewData.sections)) return reviewData.sections;
    if (!reviewData.lines || !reviewData.lines.length) return [];
    var starts = [0];
    for (var i = 1; i < reviewData.lines.length; i++) {
      var before = reviewData.lines[i - 1];
      var after = reviewData.lines[i];
      var oldJump = before.oldLineNumber != null && after.oldLineNumber != null
        && after.oldLineNumber - before.oldLineNumber > 1;
      var newJump = before.newLineNumber != null && after.newLineNumber != null
        && after.newLineNumber - before.newLineNumber > 1;
      if (oldJump || newJump) starts.push(i);
    }
    return starts.map(function (start, index) {
      var end = starts[index + 1] == null ? reviewData.lines.length : starts[index + 1];
      var slice = reviewData.lines.slice(start, end);
      var oldNumbers = slice.map(function (line) { return line.oldLineNumber; }).filter(function (line) { return line != null; });
      var newNumbers = slice.map(function (line) { return line.newLineNumber; }).filter(function (line) { return line != null; });
      return { startLineIndex: start, lineCount: end - start,
        oldStart: oldNumbers.length ? oldNumbers[0] : 0, oldLines: oldNumbers.length,
        newStart: newNumbers.length ? newNumbers[0] : 0, newLines: newNumbers.length };
    });
  }

  function lineRange(start, count) {
    if (!count) return "none";
    if (count === 1) return String(start);
    return start + "–" + (start + count - 1);
  }

  function changeHeading(sectionData, index, count) {
    var oldRange = lineRange(sectionData.oldStart, sectionData.oldLines);
    var newRange = lineRange(sectionData.newStart, sectionData.newLines);
    var heading = el("h3", "diff-section-head", el("b", null, "Change " + (index + 1) + " of " + count),
      el("span", null, "old " + oldRange + " · new " + newRange));
    heading.id = "review-change-" + (index + 1);
    heading.tabIndex = -1;
    heading.setAttribute("data-change-index", String(index));
    heading.setAttribute("aria-label", "Change " + (index + 1) + " of " + count
      + ", old lines " + oldRange + ", new lines " + newRange);
    return heading;
  }

  function renderReviewData(d, panel) {
    panel.replaceChildren();
    if (d.binary) {
      panel.appendChild(el("div", "review-state", "Binary file: line review is unavailable."));
      configureChangeNavigator(0, panel);
      renderInspector(null, d);
      scheduleReviewScrollSync();
      return;
    }
    var sections = reviewSections(d);
    var sectionByStart = Object.create(null);
    sections.forEach(function (sectionData, index) { sectionByStart[sectionData.startLineIndex] = index; });
    configureChangeNavigator(sections.length, panel);
    function actorKey(line) {
      return line.actors.slice().sort().join("\u0000");
    }
    var grouped = {};
    var runHeads = {};
    for (var runStart = 0; runStart < d.lines.length;) {
      var first = d.lines[runStart];
      if (first.type === "eq" || !first.actors.length) { runStart += 1; continue; }
      var key = actorKey(first);
      var runEnd = runStart + 1;
      while (runEnd < d.lines.length && d.lines[runEnd].type !== "eq" && actorKey(d.lines[runEnd]) === key) runEnd += 1;
      if (runEnd - runStart > 1) {
        var runHead = el("div", "diff-run-head");
        first.actors.forEach(function (actor) { runHead.appendChild(chip(actor)); });
        var runLength = runEnd - runStart;
        runHead.appendChild(el("span", "run-count", runLength + " changed lines"));
        var runPrompts = collectPromptEntries(d.lines, runStart, runEnd);
        var runPromptControl = promptControl(runPrompts,
          runLength + " changed lines by " + first.actors.join(", "),
          d.path + ":run:" + runStart, d);
        if (runPromptControl) runHead.appendChild(runPromptControl);
        runHeads[runStart] = runHead;
        for (var groupedLine = runStart; groupedLine < runEnd; groupedLine++) grouped[groupedLine] = true;
      }
      runStart = runEnd;
    }
    d.lines.forEach(function (line, lineIndex) {
      if (sectionByStart[lineIndex] != null) {
        var sectionIndex = sectionByStart[lineIndex];
        panel.appendChild(changeHeading(sections[sectionIndex], sectionIndex, sections.length));
      }
      if (runHeads[lineIndex]) panel.appendChild(runHeads[lineIndex]);
      var meta = el("div", "line-meta");
      if (!grouped[lineIndex]) {
        if (line.actors.length) line.actors.forEach(function (actor) { meta.appendChild(chip(actor)); });
        else if (line.type !== "eq") meta.appendChild(el("span", "un", "unattributed"));
      }
      if (line.conflicted) meta.appendChild(badge("contended", "conflict"));
      if (!grouped[lineIndex]) {
        var linePrompts = collectPromptEntries(d.lines, lineIndex, lineIndex + 1);
        var linePromptControl = promptControl(linePrompts,
          "Line " + (line.newLineNumber || line.oldLineNumber || lineIndex + 1) + " by " + line.actors.join(", "),
          d.path + ":line:" + lineIndex, d);
        if (linePromptControl) meta.appendChild(linePromptControl);
      }
      var kind = line.type === "add" ? "add" : line.type === "del" ? "del" : "eq";
      var sign = line.type === "add" ? "+" : line.type === "del" ? "−" : " ";
      panel.appendChild(el("div", "diff-line " + kind + (line.conflicted ? " conflict" : ""),
        el("span", "ln", line.oldLineNumber == null ? "" : String(line.oldLineNumber)),
        el("span", "ln", line.newLineNumber == null ? "" : String(line.newLineNumber)),
        el("span", "sign", sign), el("span", "code", line.text), meta));
    });
    panel.appendChild(el("div", "review-notes",
      "Conflicts keep every credited actor visible. Unattributed lines are called out plainly."));
    renderInspector(PROMPT_CONTEXT, d);
    scheduleReviewScrollSync();
  }

  function loadReview(path, panel) {
    var cached = REVIEW_CACHE[path];
    if (cached) renderReviewData(cached, panel);
    else panel.replaceChildren(el("div", "review-state", "Loading local provenance…"));
    var requestId = String(++REVIEW_REQUEST_ID);
    REVIEW_REQUEST_BY_PATH[path] = requestId;
    panel.setAttribute("data-review-request", requestId);
    fetch("/api/blame?path=" + encodeURIComponent(path)).then(function (r) {
      if (!r.ok) throw new Error("http " + r.status);
      return r.json();
    }).then(function (d) {
      if (REVIEW_REQUEST_BY_PATH[path] !== requestId) return;
      var signature = JSON.stringify(d);
      var changed = REVIEW_CACHE_SIGNATURE[path] !== signature;
      REVIEW_CACHE[path] = d;
      REVIEW_CACHE_SIGNATURE[path] = signature;
      if (!panel.isConnected || panel.getAttribute("data-review-request") !== requestId) return;
      if (ACTIVE_VIEW === "review" && SELECTED_FILE === path && (!cached || changed)) {
        if (cached && changed) PROMPT_CONTEXT = null;
        renderReviewData(d, panel);
      }
    }).catch(function () {
      if (REVIEW_REQUEST_BY_PATH[path] !== requestId) return;
      if (!cached && panel.isConnected && panel.getAttribute("data-review-request") === requestId) {
        panel.replaceChildren(el("div", "review-state", "Could not load this review."));
        configureChangeNavigator(0, panel);
      }
      scheduleReviewScrollSync();
    });
  }

  function avatarFor(actor) {
    var avatar = el("span", "actor-avatar", actor.id.charAt(0).toUpperCase());
    avatar.style.background = "color-mix(in srgb," + colorFor(actor.id) + " 18%,var(--card))";
    avatar.style.border = "1px solid " + colorFor(actor.id);
    avatar.style.color = deepFor(actor.id);
    return avatar;
  }

  function attentionEntries(d) {
    var entries = [];
    d.needsYou.forEach(function (item) {
      var blocked = d.blocked.find(function (record) { return record.actor === item.actor && record.target === item.target; });
      var queued = d.queue.find(function (record) { return record.actor === item.actor && record.target === item.target; });
      var intents = [];
      if (blocked && blocked.holderIntent) intents.push({ label: blocked.holder + " intends", text: blocked.holderIntent });
      else if (queued && queued.intent) intents.push({ label: item.actor + " queued intent", text: queued.intent });
      entries.push({ kind: "Needs you", target: item.target, meta: item.actor + " · " + ago(item.ts),
        reason: item.note || "An agent asked for a human decision.", intents: intents,
        commands: ["quilt resolve -- " + shellArg(item.target)] });
    });
    d.clobbers.forEach(function (item) {
      entries.push({ kind: "Overwrite preserved", target: item.path, meta: item.byActor + " → " + item.victimActor,
        reason: item.byActor + " overwrote " + item.victimActor + "'s uncommitted lines. Both versions are preserved.", intents: [],
        commands: ["quilt restore -- " + shellArg(item.path), "quilt undo -- " + shellArg(item.byActor)] });
    });
    d.overlaps.filter(function (item) { return item.kind === "contended"; }).forEach(function (item) {
      entries.push({ kind: "Same-line clash", target: item.path, meta: item.actors.join(" + "),
        reason: item.lines + (item.lines === 1 ? " line is" : " lines are") + " credited to competing actors and need review.", intents: [],
        commands: ["quilt conflicts"] });
    });
    return entries;
  }

  function renderOverview(d, main) {
    var entries = attentionEntries(d);
    var actorViews = d.actors.map(function (actor) { return { actor: actor, state: actorState(d, actor) }; });
    var engaged = actorViews.filter(function (view) { return view.state.engaged; });
    var idle = actorViews.filter(function (view) { return !view.state.engaged; });
    var changedLines = d.files.reduce(function (sum, file) { return sum + file.changedLines; }, 0);

    var health = el("div", "health-block" + (entries.length ? " attention" : ""),
      el("span", "health-dot"), el("div", "health-copy",
        el("strong", null, entries.length ? entries.length + (entries.length === 1 ? " item needs you" : " items need you") : "No intervention needed"),
        el("span", "freshness", "Updated just now")));
    var metrics = el("div", "summary-metrics",
      el("div", "summary-metric", el("b", null, String(engaged.length)), el("span", null, "engaged agents")),
      el("div", "summary-metric", el("b", null, String(d.files.length)), el("span", null, "changed files")),
      el("div", "summary-metric", el("b", null, String(changedLines)), el("span", null, "changed lines")));
    var summary = el("div", "run-summary", health, metrics);
    summary.setAttribute("role", "status");
    main.appendChild(summary);

    if (entries.length) {
      var attention = section("Attention", "Handle these before commit");
      var list = el("div", "attention-list");
      entries.forEach(function (entry) {
        var head = el("div", "attention-head", el("span", "attention-kind", entry.kind),
          el("span", "attention-target", entry.target), el("span", "attention-meta", entry.meta));
        var body = el("div", "attention-body", el("div", "attention-reason", entry.reason));
        if (entry.intents.length) {
          var intents = el("div", "intent-pair");
          entry.intents.slice(0, 2).forEach(function (intent) {
            intents.appendChild(el("div", "intent", el("span", null, intent.label), el("p", null, intent.text)));
          });
          body.appendChild(intents);
        }
        var commands = el("div", "command-stack");
        entry.commands.forEach(function (command) { commands.appendChild(commandButton(command)); });
        body.appendChild(commands);
        list.appendChild(el("article", "attention-item", head, body));
      });
      attention.appendChild(list);
      main.appendChild(attention);
    }

    var active = section("Active work", engaged.length ? engaged.length + (engaged.length === 1 ? " engaged agent" : " engaged agents") : "No agents are engaged");
    if (engaged.length) {
      var actorList = el("div", "actor-list");
      engaged.forEach(function (view) {
        var actor = view.actor;
        var state = view.state;
        var content = el("div", "actor-summary", avatarFor(actor),
          el("div", "actor-main", el("span", "actor-name", actor.id), el("span", "actor-kind", actor.type)),
          el("span", "actor-state " + state.key, state.label));
        var row = actor.files.length
          ? setFocusKey(el("button", "actor-row actor-button", content,
              el("div", "actor-detail", state.detail, state.sub ? el("span", "actor-detail-sub", state.sub) : null)), "actor:" + actor.id)
          : el("div", "actor-row", content,
              el("div", "actor-detail", state.detail, state.sub ? el("span", "actor-detail-sub", state.sub) : null));
        if (actor.files.length) {
          row.type = "button";
          row.setAttribute("aria-label", "Review changes from " + actor.id);
          row.addEventListener("click", function () {
            ACTIVE_FILTER = actor.id;
            SELECTED_FILE = filesForScope(d)[0] ? filesForScope(d)[0].path : null;
            switchView("review", "review-file:" + SELECTED_FILE);
          });
        }
        actorList.appendChild(row);
      });
      active.appendChild(actorList);
    } else active.appendChild(el("div", "empty", "No agents are editing, blocked, queued, or holding claims."));
    if (idle.length) {
      var idleDetails = el("details", "idle-actors");
      idleDetails.appendChild(el("summary", null, idle.length + (idle.length === 1 ? " idle session" : " idle sessions")));
      var idleNames = el("div", "idle-names");
      idle.forEach(function (view) { idleNames.appendChild(el("span", "idle-name", view.actor.id)); });
      idleDetails.appendChild(idleNames);
      active.appendChild(idleDetails);
    }
    main.appendChild(active);

    if (d.files.length) {
      var fileCount = d.files.length + (d.files.length === 1 ? " file ready" : " files ready");
      var review = section("Review changes", null);
      var openReview = setFocusKey(el("button", "review-workspace-button", "Open review workspace"), "overview-review-workspace");
      openReview.type = "button";
      openReview.setAttribute("aria-label", "Open Review tab for " + fileCount);
      openReview.addEventListener("click", function () {
        ACTIVE_FILTER = null;
        var selectedStillExists = d.files.some(function (file) { return file.path === SELECTED_FILE; });
        SELECTED_FILE = selectedStillExists ? SELECTED_FILE : d.files[0].path;
        switchView("review", "review-file:" + SELECTED_FILE);
      });
      review.firstChild.appendChild(el("div", "review-section-actions", el("span", "section-note", fileCount), openReview));
      var queue = el("ul", "review-queue");
      d.files.forEach(function (file) {
        var row = el("li", "review-row", el("span", "review-path", file.path));
        if (file.overlap === "contended") row.appendChild(badge("contended", "clash"));
        if (file.isNew) row.appendChild(badge("new", "new"));
        file.actors.forEach(function (actor) { row.appendChild(chip(actor.id, actor.lines)); });
        if (file.unattributedLines) row.appendChild(el("span", "un", "+" + file.unattributedLines + " unattributed"));
        queue.appendChild(row);
      });
      review.appendChild(queue);
      main.appendChild(review);
    }

    var signals = [];
    d.dependencyWarnings.forEach(function (warning) {
      signals.push({ kind: "Dependency", text: warning.yourSymbol + " depends on " + warning.dependency + " held by " + warning.heldBy });
    });
    d.unattributed.forEach(function (path) { signals.push({ kind: "Unattributed", text: path + " has unattributed changes" }); });
    d.sewn.forEach(function (item) { signals.push({ kind: "Resolved", text: item.actor + " reconciled " + item.target + (item.note ? ": " + item.note : "") }); });
    if (signals.length) {
      var signalsSection = section("Signals", "Useful context, not active blockers");
      var signalList = el("div", "signal-list");
      signals.forEach(function (signal) { signalList.appendChild(el("div", "signal-row", el("div", "signal-kind", signal.kind), el("div", null, signal.text))); });
      signalsSection.appendChild(signalList);
      main.appendChild(signalsSection);
    }
  }

  function renderReviewView(d, main) {
    var scopedFiles = filesForScope(d);
    if (!SELECTED_FILE || !scopedFiles.some(function (file) { return file.path === SELECTED_FILE; })) {
      SELECTED_FILE = scopedFiles[0] ? scopedFiles[0].path : null;
    }
    var workspace = el("div", "review-workspace");
    workspace.id = "review-workspace";
    var reviewHeading = setFocusKey(el("h2", "review-side-title", "Review"), "review-top");
    reviewHeading.tabIndex = -1;
    var sidebar = el("aside", "review-sidebar",
      el("div", "review-side-head", reviewHeading,
        el("div", "review-side-sub", scopedFiles.length + (scopedFiles.length === 1 ? " changed file" : " changed files"))));
    var scopes = el("div", "scope-list");
    [null].concat(contributorIds(d)).forEach(function (actorId) {
      var label = actorId || "All";
      var button = setFocusKey(el("button", "scope-button", label), "scope:" + label);
      button.type = "button";
      button.setAttribute("aria-pressed", ACTIVE_FILTER === actorId ? "true" : "false");
      button.addEventListener("click", function () {
        ACTIVE_FILTER = actorId;
        SELECTED_FILE = filesForScope(d)[0] ? filesForScope(d)[0].path : null;
        PROMPT_CONTEXT = null;
        render(d, "scope:" + label);
        scrollReviewWorkspaceToTop(false, false);
      });
      scopes.appendChild(button);
    });
    sidebar.appendChild(scopes);
    var fileList = el("div", "review-files");
    scopedFiles.forEach(function (file) {
      var stateClass = file.overlap === "contended" ? " clash" : file.unattributedLines ? " unowned" : "";
      var button = setFocusKey(el("button", "review-file" + stateClass, el("span", "file-dot"), el("span", null, file.path)), "review-file:" + file.path);
      button.type = "button";
      button.setAttribute("aria-current", SELECTED_FILE === file.path ? "true" : "false");
      button.addEventListener("click", function () {
        SELECTED_FILE = file.path;
        PROMPT_CONTEXT = null;
        render(d, "review-file:" + file.path);
        scrollReviewWorkspaceToTop(false, false);
      });
      fileList.appendChild(button);
    });
    sidebar.appendChild(fileList);
    workspace.appendChild(sidebar);

    var stage = el("section", "review-stage");
    stage.id = "review-stage";
    var selected = scopedFiles.find(function (file) { return file.path === SELECTED_FILE; });
    if (selected) {
      var meta = selected.actors.map(function (actor) { return actor.id + " " + actor.lines; }).join(" · ");
      if (selected.unattributedLines) meta += (meta ? " · " : "") + selected.unattributedLines + " unattributed";
      var stageFile = el("div", "stage-file", el("h2", "stage-path", selected.path), el("div", "stage-meta", meta || "No owner recorded"));
      var actions = el("div", "stage-actions");
      var commandActor = ACTIVE_FILTER || (selected.actors.length === 1 ? selected.actors[0].id : null);
      actions.appendChild(commandButton(commandActor
        ? "quilt " + shellArg("--as=" + commandActor) + " preview --mine -- " + shellArg(selected.path)
        : "quilt status", commandActor ? "copy preview" : "copy status"));
      stage.appendChild(el("div", "review-stage-head", stageFile, actions));

      var previousChange = setFocusKey(el("button", "change-nav-button", uiIcon("arrow-up"),
        el("span", null, "Previous")), "review-change-previous");
      previousChange.id = "review-change-previous";
      previousChange.type = "button";
      previousChange.setAttribute("aria-label", "Previous changed code section");
      previousChange.setAttribute("aria-keyshortcuts", "Alt+ArrowUp");
      previousChange.setAttribute("aria-controls", "review-diff");
      previousChange.setAttribute("aria-disabled", "true");
      previousChange.title = "Previous change (Option/Alt + Up Arrow)";
      previousChange.addEventListener("click", function () { goToChange(-1); });
      var changeStatus = el("span", "change-nav-status", "Loading changes…");
      changeStatus.id = "review-change-status";
      var nextChange = setFocusKey(el("button", "change-nav-button", el("span", null, "Next"),
        uiIcon("arrow-down")), "review-change-next");
      nextChange.id = "review-change-next";
      nextChange.type = "button";
      nextChange.setAttribute("aria-label", "Next changed code section");
      nextChange.setAttribute("aria-keyshortcuts", "Alt+ArrowDown");
      nextChange.setAttribute("aria-controls", "review-diff");
      nextChange.setAttribute("aria-disabled", "true");
      nextChange.title = "Next change (Option/Alt + Down Arrow)";
      nextChange.addEventListener("click", function () { goToChange(1); });
      var changeNavigator = el("nav", "change-navigator", previousChange, changeStatus, nextChange);
      changeNavigator.id = "review-change-navigator";
      changeNavigator.setAttribute("aria-label", "Changed code navigation");
      changeNavigator.setAttribute("aria-hidden", "true");
      var changeLive = el("span", "sr-only");
      changeLive.id = "review-change-live";
      changeLive.setAttribute("aria-live", "polite");

      var backToTop = setFocusKey(el("button", "back-to-top", uiIcon("arrow-bar-to-up"),
        el("span", null, "Back to top")), "review-back-to-top");
      backToTop.id = "review-back-to-top";
      backToTop.type = "button";
      backToTop.tabIndex = -1;
      backToTop.setAttribute("aria-hidden", "true");
      backToTop.setAttribute("aria-controls", "review-workspace");
      backToTop.setAttribute("aria-label", "Back to top of Review for " + selected.path);
      backToTop.addEventListener("click", function () {
        scrollReviewWorkspaceToTop(true, true);
      });
      var navDock = el("div", "review-nav-dock", changeNavigator, changeLive, backToTop);
      navDock.id = "review-nav-dock";
      stage.appendChild(navDock);
      var panel = el("div", "review");
      panel.id = "review-diff";
      panel.setAttribute("aria-label", "Diff for " + selected.path);
      stage.appendChild(panel);
      workspace.appendChild(stage);
      var inspector = el("aside", "review-inspector", el("div", "inspector-head", el("h2", "inspector-title", "Context")),
        el("div", "inspector-body", el("p", "inspector-copy", "Loading local provenance…")));
      inspector.id = "review-inspector";
      var promptBackdrop = el("div", "prompt-backdrop");
      promptBackdrop.id = "review-prompt-backdrop";
      promptBackdrop.setAttribute("aria-hidden", "true");
      promptBackdrop.addEventListener("click", function () {
        closePromptContext(REVIEW_CACHE[selected.path] || null, true);
      });
      workspace.appendChild(promptBackdrop);
      workspace.appendChild(inspector);
      loadReview(selected.path, panel);
    } else {
      stage.appendChild(el("div", "review-empty", ACTIVE_FILTER ? "This actor has no changed files." : "There are no changed files to review."));
      workspace.appendChild(stage);
      var emptyInspector = el("aside", "review-inspector", el("div", "inspector-head", el("h2", "inspector-title", "Context")),
        el("div", "inspector-body", el("p", "inspector-copy", "Choose a file to inspect provenance.")));
      emptyInspector.id = "review-inspector";
      workspace.appendChild(emptyInspector);
    }
    main.appendChild(workspace);
  }

  function render(d, preferredFocusKey) {
    LAST_DATA = d;
    syncPromptModalState(false);
    var focusKey = preferredFocusKey || activeFocusKey();
    document.getElementById("repo").textContent = d.repo;
    document.getElementById("headsha").textContent = d.head;
    document.getElementById("ver").textContent = d.version;
    var marks = document.getElementById("mark").children;
    var brandColors = ["#5aa9e6", "#d074c4", "#8fc46f", "#e5a06b"];
    for (var i = 0; i < marks.length; i++) marks[i].style.background = brandColors[i];

    var entries = attentionEntries(d);
    document.getElementById("counts").textContent = entries.length + " attention · " + d.files.length + " files";
    var main = el("main", null, viewTabs());

    if (!d.actors.length && !d.files.length && !d.needsYou.length) {
      var kv = el("div", "kv", "$ quilt setup", el("br"), "$ claude  ", el("span", "un", "# as many terminals as you like"));
      main.appendChild(el("div", "empty", "Nothing on the quilt yet.", el("br"),
        "Start agents in this repo and their work shows up here as it happens.", kv));
    } else if (ACTIVE_VIEW === "review") renderReviewView(d, main);
    else renderOverview(d, main);

    var old = document.getElementById("main");
    main.id = "main";
    old.replaceWith(main);
    if (ACTIVE_VIEW === "review" && SELECTED_FILE && REVIEW_CACHE[SELECTED_FILE]) {
      renderInspector(PROMPT_CONTEXT, REVIEW_CACHE[SELECTED_FILE]);
    }
    restoreFocus(focusKey);
    scheduleReviewScrollSync();
  }

  function tick() {
    fetch("/api/fleet").then(function (r) {
      if (!r.ok) throw new Error("http " + r.status);
      return r.json();
    }).then(function (d) {
      document.getElementById("banner").style.display = "none";
      document.getElementById("live").classList.remove("stale");
      LAST_UPDATED_AT = Date.now();
      document.getElementById("livetext").textContent = "updated now";
      var signatureData = {};
      Object.keys(d).forEach(function (key) {
        if (key !== "generatedAt") signatureData[key] = d[key];
      });
      var signature = JSON.stringify(signatureData);
      if (signature !== LAST_SIGNATURE) {
        LAST_SIGNATURE = signature;
        render(d);
      }
    }).catch(function () {
      document.getElementById("banner").style.display = "block";
      document.getElementById("live").classList.add("stale");
      document.getElementById("livetext").textContent = "reconnecting";
    });
  }
  function updateFreshness() {
    if (!LAST_UPDATED_AT || document.getElementById("live").classList.contains("stale")) return;
    var seconds = Math.max(0, Math.floor((Date.now() - LAST_UPDATED_AT) / 1000));
    document.getElementById("livetext").textContent = seconds < 2 ? "updated now" : "updated " + seconds + "s ago";
    var inline = document.querySelector(".freshness");
    if (inline) inline.textContent = seconds < 2 ? "Updated just now" : "Updated " + seconds + "s ago";
  }
  var themeButton = document.getElementById("theme-toggle");
  var storedTheme = null;
  try { storedTheme = localStorage.getItem("quilt-ui-theme"); } catch (e) {}
  if (storedTheme === "dark" || storedTheme === "light") document.body.dataset.theme = storedTheme;
  function syncThemeButton() {
    var dark = document.body.dataset.theme === "dark";
    themeButton.textContent = dark ? "☀" : "☾";
    themeButton.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
  }
  syncThemeButton();
  themeButton.addEventListener("click", function () {
    document.body.dataset.theme = document.body.dataset.theme === "dark" ? "light" : "dark";
    try { localStorage.setItem("quilt-ui-theme", document.body.dataset.theme); } catch (e) {}
    syncThemeButton();
    if (LAST_DATA) render(LAST_DATA);
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && PROMPT_CONTEXT) {
      event.preventDefault();
      closePromptContext(SELECTED_FILE ? REVIEW_CACHE[SELECTED_FILE] : null, true);
      return;
    }
    if (event.key === "Tab" && PROMPT_CONTEXT && window.matchMedia("(max-width: 820px)").matches) {
      var inspector = document.getElementById("review-inspector");
      if (!inspector) return;
      var focusable = inspector.querySelectorAll("button:not([disabled]), [href], pre[tabindex='0']");
      if (!focusable.length) return;
      var activeIndex = Array.prototype.indexOf.call(focusable, document.activeElement);
      if (activeIndex === -1 || (event.shiftKey && activeIndex === 0) || (!event.shiftKey && activeIndex === focusable.length - 1)) {
        event.preventDefault();
        focusable[event.shiftKey ? focusable.length - 1 : 0].focus();
      }
      return;
    }
    var target = event.target;
    var editable = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA"
      || target.tagName === "SELECT" || target.isContentEditable);
    if (!PROMPT_CONTEXT && ACTIVE_VIEW === "review" && event.altKey && !event.metaKey && !event.ctrlKey
      && !event.shiftKey && !editable && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      if (goToChange(event.key === "ArrowUp" ? -1 : 1)) event.preventDefault();
    }
  });
  window.addEventListener("scroll", scheduleReviewScrollSync, { passive: true });
  window.addEventListener("resize", function () {
    syncPromptPresentation();
    scheduleReviewScrollSync();
  });
  tick();
  setInterval(tick, 2000);
  setInterval(updateFreshness, 1000);
})();
</script>
</body>
</html>
`;
