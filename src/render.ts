import pc from "picocolors";
import {
  type FileModel,
  type HunkOwnership,
  type WorktreeModel,
} from "./engine.js";

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

interface FileBuckets {
  mine: FileModel[];
  shared: FileModel[];
  others: FileModel[];
  unclaimed: FileModel[];
}

function dominant(file: FileModel): HunkOwnership | "binary" {
  if (file.binary) return "binary";
  const counts: Record<string, number> = {};
  for (const h of file.hunks) counts[h.ownership] = (counts[h.ownership] ?? 0) + 1;
  if (counts["shared"]) return "shared";
  if ((counts["mine"] ?? 0) + (counts["mixed"] ?? 0) > 0) {
    if (counts["other"]) return "shared"; // mine + other in same file
    if (counts["mixed"]) return "mixed";
    return "mine";
  }
  if (counts["other"]) return "other";
  return "unclaimed";
}

export function bucketFiles(model: WorktreeModel): FileBuckets {
  const b: FileBuckets = { mine: [], shared: [], others: [], unclaimed: [] };
  for (const file of model.files) {
    const d = dominant(file);
    if (d === "mine" || d === "mixed") b.mine.push(file);
    else if (d === "shared") b.shared.push(file);
    else if (d === "other") b.others.push(file);
    else b.unclaimed.push(file);
  }
  return b;
}

function fileLineSummary(file: FileModel, only?: Set<HunkOwnership>): string {
  let added = 0;
  let removed = 0;
  for (const h of file.hunks) {
    if (only && !only.has(h.ownership)) continue;
    for (const op of h.hunk.ops) {
      if (op.type === "add") added++;
      else if (op.type === "del") removed++;
    }
  }
  const parts: string[] = [];
  if (added) parts.push(pc.green(`+${added}`));
  if (removed) parts.push(pc.red(`-${removed}`));
  return parts.join(" ") || pc.dim("no line changes");
}

function tag(file: FileModel): string {
  if (file.binary) return pc.dim("binary");
  if (file.isNew) return pc.cyan("new");
  if (file.isDeleted) return pc.magenta("deleted");
  return "";
}

export function renderStatus(model: WorktreeModel, baseLabel: string): string {
  const out: string[] = [];
  out.push("");
  out.push(pc.bold("  Quilt status"));
  out.push("");
  out.push(
    `  ${pc.dim("Actor:")} ${model.activeActorId ? pc.bold(model.activeActorId) : pc.yellow("(none — run quilt start)")}`,
  );
  out.push(`  ${pc.dim("Base: ")} ${baseLabel}`);
  out.push("");

  if (model.files.length === 0) {
    out.push(pc.dim("  Working tree clean. Nothing to attribute."));
    out.push("");
    return out.join("\n");
  }

  const b = bucketFiles(model);
  const mineOnly = new Set<HunkOwnership>(["mine"]);

  if (b.mine.length) {
    out.push(pc.green(pc.bold("  Safe to commit:")));
    for (const file of b.mine) {
      const t = tag(file);
      out.push(`    ${file.path}${t ? "  " + t : ""}   ${fileLineSummary(file, mineOnly)}`);
      const mixed = file.hunks.filter((h) => h.ownership === "mixed").length;
      if (mixed) {
        out.push(
          pc.yellow(
            `      ⚠ ${plural(mixed, "hunk")} also touch unattributed lines — use --include-unclaimed to commit`,
          ),
        );
      }
    }
    out.push("");
  }

  if (b.shared.length) {
    out.push(pc.yellow(pc.bold("  Shared / needs review:")));
    for (const file of b.shared) {
      const actors = new Set<string>();
      let contended = false;
      for (const h of file.hunks) {
        for (const a of h.actors) actors.add(a);
        if (h.overlap === "contended") contended = true;
      }
      out.push(`    ${file.path}   ${fileLineSummary(file)}`);
      out.push(
        `      ${pc.dim("touched by:")} ${[...actors].join(", ") || pc.dim("unknown")}` +
          (contended
            ? pc.red("   status: same-line clash — review")
            : pc.dim("   status: adjacent edits — commits cleanly")),
      );
    }
    out.push("");
  }

  if (b.others.length) {
    out.push(pc.blue(pc.bold("  Owned by others:")));
    for (const file of b.others) {
      const actors = new Set<string>();
      for (const h of file.hunks) for (const a of h.actors) actors.add(a);
      out.push(
        `    ${file.path}   ${fileLineSummary(file)}   ${pc.dim([...actors].join(", "))}`,
      );
    }
    out.push("");
  }

  if (b.unclaimed.length) {
    out.push(pc.dim(pc.bold("  Unclaimed:")));
    for (const file of b.unclaimed) {
      const t = tag(file);
      out.push(
        `    ${file.path}${t ? "  " + t : ""}   ${fileLineSummary(file)}   ${pc.dim("pre-existing / generated?")}`,
      );
    }
    out.push("");
  }

  out.push(pc.dim("  Next:"));
  out.push(pc.dim("    quilt preview --mine"));
  out.push(pc.dim('    quilt commit --mine -m "..."'));
  out.push("");
  return out.join("\n");
}

export function renderPreview(patch: string): string {
  if (!patch.trim()) return pc.dim("Nothing owned by you to commit.");
  const out: string[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) out.push(pc.bold(line));
    else if (line.startsWith("diff --git")) out.push(pc.bold(pc.cyan(line)));
    else if (line.startsWith("@@")) out.push(pc.cyan(line));
    else if (line.startsWith("+")) out.push(pc.green(line));
    else if (line.startsWith("-")) out.push(pc.red(line));
    else out.push(line);
  }
  return out.join("\n");
}
