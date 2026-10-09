import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const SRC = path.resolve(fileURLToPath(new URL("../src/", import.meta.url)));

export async function resolve(specifier, context, next) {
  let target = specifier;
  if (specifier.startsWith("@/")) target = pathToFileURL(path.join(SRC, specifier.slice(2))).href;
  if (target.startsWith(".") || target.startsWith("file:") || target.startsWith("/")) {
    const base = target.startsWith("file:") ? fileURLToPath(target) : path.resolve(path.dirname(fileURLToPath(context.parentURL)), target);
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
      if (existsSync(candidate) && !candidate.endsWith(path.sep) && path.extname(candidate)) return next(pathToFileURL(candidate).href, context);
    }
  }
  return next(specifier, context);
}
