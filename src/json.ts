import type { WorktreeModel } from "./engine.js";
import type { Selection } from "./commit.js";

function hunkAddRemove(ops: { type: string }[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === "add") added++;
    else if (op.type === "del") removed++;
  }
  return { added, removed };
}

export function statusJson(model: WorktreeModel, base: string | null) {
  const summary = { mine: 0, shared: 0, others: 0, unclaimed: 0 };
  const files = model.files.map((file) => {
    let fileClass = "unclaimed";
    const hunks = file.hunks.map((h) => {
      const { added, removed } = hunkAddRemove(h.hunk.ops);
      return {
        ownership: h.ownership,
        actors: h.actors,
        conflicted: h.conflicted,
        added,
        removed,
        oldStart: h.hunk.oldStart,
        oldLines: h.hunk.oldLines,
        newStart: h.hunk.newStart,
        newLines: h.hunk.newLines,
      };
    });
    const owns = new Set(file.hunks.map((h) => h.ownership));
    if (owns.has("shared") || (owns.has("mine") && owns.has("other"))) fileClass = "shared";
    else if (owns.has("mine") || owns.has("mixed")) fileClass = "mine";
    else if (owns.has("other")) fileClass = "other";
    if (fileClass === "mine") summary.mine++;
    else if (fileClass === "shared") summary.shared++;
    else if (fileClass === "other") summary.others++;
    else summary.unclaimed++;
    return {
      path: file.path,
      new: file.isNew,
      deleted: file.isDeleted,
      binary: file.binary,
      class: fileClass,
      hunks,
    };
  });
  return { actor: model.activeActorId, base, files, summary };
}

export function mineJson(selection: Selection, includePatch: boolean) {
  return {
    files: selection.files,
    totalAdded: selection.totalAdded,
    totalRemoved: selection.totalRemoved,
    hasMixed: selection.hasMixed,
    blockedFiles: selection.blockedFiles,
    ...(includePatch ? { patch: selection.patch } : {}),
  };
}

export function conflictsJson(model: WorktreeModel) {
  const out: Array<{ path: string; actors: string[]; lines: number }> = [];
  for (const file of model.files) {
    const conflicted = file.hunks.filter((h) => h.conflicted || h.ownership === "shared");
    if (conflicted.length === 0) continue;
    const actors = new Set<string>();
    let lines = 0;
    for (const h of conflicted) {
      for (const a of h.actors) actors.add(a);
      lines += h.hunk.ops.filter((o) => o.type !== "eq").length;
    }
    out.push({ path: file.path, actors: [...actors], lines });
  }
  return { conflicts: out };
}
