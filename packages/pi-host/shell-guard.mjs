import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve, sep } from "node:path";

// Split a bash command line into simple commands (word arrays). It is a guard, not a
// parser: quotes, escapes, comments, heredoc bodies and redirections are handled, and
// anything unclear errs towards treating text as a command.
export function simpleCommands(command) {
  const out = [];
  let words = [];
  let word = null;
  const heredocs = [];
  const endWord = () => { if (word !== null) { words.push(word); word = null; } };
  const endSegment = () => { endWord(); if (words.length) out.push(words); words = []; };
  let i = 0;
  while (i < command.length) {
    const c = command[i];
    if (c === "'") {
      const j = command.indexOf("'", i + 1);
      const end = j === -1 ? command.length : j;
      word = (word ?? "") + command.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let text = "";
      while (j < command.length && command[j] !== '"') {
        if (command[j] === "\\" && j + 1 < command.length) { text += command[j + 1]; j += 2; } else text += command[j++];
      }
      word = (word ?? "") + text;
      i = j + 1;
      continue;
    }
    if (c === "\\") {
      if (command[i + 1] !== "\n") word = (word ?? "") + (command[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (c === "#" && word === null) { while (i < command.length && command[i] !== "\n") i++; continue; }
    if (c === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
      // Heredoc: remember the delimiter and skip its body at the next newline.
      endWord();
      i += 2;
      const strip = command[i] === "-";
      if (strip) i++;
      while (command[i] === " " || command[i] === "\t") i++;
      let delimiter = "";
      while (i < command.length && !/[\s;&|<>()]/.test(command[i])) { if (command[i] !== "'" && command[i] !== '"') delimiter += command[i]; i++; }
      heredocs.push({ delimiter, strip });
      continue;
    }
    if (c === "\n") {
      endSegment();
      i++;
      for (const { delimiter, strip } of heredocs.splice(0)) {
        for (;;) {
          if (i >= command.length) break;
          const end = command.indexOf("\n", i);
          const line = command.slice(i, end === -1 ? command.length : end);
          i = end === -1 ? command.length : end + 1;
          if ((strip ? line.replace(/^\t+/, "") : line) === delimiter) break;
        }
      }
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") { endWord(); i++; continue; }
    if (c === "&" && (command[i - 1] === ">" || command[i - 1] === "<" || command[i + 1] === ">")) { word = (word ?? "") + c; i++; continue; }
    if (";|&()`".includes(c)) { endSegment(); i++; continue; }
    word = (word ?? "") + c;
    i++;
  }
  endSegment();
  return out.map(withoutRedirections).filter((segment) => segment.length);
}

function withoutRedirections(words) {
  const kept = [];
  for (let k = 0; k < words.length; k++) {
    const w = words[k];
    if (/^\d*(>>|>\||>&|>|<<<|<&|<|&>>|&>)$/.test(w)) { k++; continue; }
    if (/^\d*(>|<|&>)/.test(w)) continue;
    kept.push(w);
  }
  return kept;
}

const RESERVED = new Set(["then", "do", "else", "elif", "if", "while", "until", "!", "{", "}", "time", "nohup", "exec", "command", "builtin", "fi", "done"]);
const SUDO_VALUE = new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U"]);

function unwrap(words) {
  let k = 0;
  for (;;) {
    const w = words[k];
    if (w === undefined) return [];
    if (RESERVED.has(w) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { k++; continue; }
    const name = basename(w);
    if (name === "sudo" || name === "env" || name === "nice" || name === "timeout" || name === "stdbuf") {
      k++;
      while (words[k]?.startsWith("-") || (name === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k] ?? ""))) {
        if ((name === "sudo" && SUDO_VALUE.has(words[k])) || (name === "nice" && words[k] === "-n")) k++;
        k++;
      }
      if (name === "timeout" && /^\d/.test(words[k] ?? "")) k++;
      continue;
    }
    return words.slice(k);
  }
}

function expand(word, env, home) {
  let value = word.replace(/^~(?=\/|$)/, home);
  value = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, a, b) => {
    const name = a ?? b;
    return name === "HOME" ? home : env[name] ?? "";
  });
  return value;
}

// Short-option clusters such as -fdx, before any "--".
function flags(args) {
  const end = args.indexOf("--");
  const options = end === -1 ? args : args.slice(0, end);
  const long = new Set(options.filter((a) => a.startsWith("--")).map((a) => a.split("=")[0]));
  const short = new Set(options.filter((a) => /^-[A-Za-z]+$/.test(a)).flatMap((a) => [...a.slice(1)]));
  return { long, short, has: (name, letter) => long.has(name) || (letter !== undefined && short.has(letter)) };
}

function git(cwd, args) {
  try { return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; }
}

const BROAD = new Set([".", "./", ":/", ":/*", "*", ":(top)", ":(top)."]);
const PROTECTED_BRANCH = /^(refs\/heads\/)?(main|master)$/;

/**
 * Why a command would destroy work, or null. cwd follows leading and chained cd.
 * protectedPaths are refused as rm -r targets, along with any folder holding one.
 */
export function destructiveReason(command, { cwd, protectedPaths = [], env = process.env, home = homedir(), depth = 0 } = {}) {
  let here = cwd;
  const guarded = [...new Set(["/", home, ...protectedPaths].filter(Boolean).map((path) => resolve(path)))];
  for (const raw of simpleCommands(command)) {
    const words = unwrap(raw);
    if (!words.length) continue;
    const name = basename(words[0]);
    const args = words.slice(1);
    if (name === "cd" || name === "pushd") {
      const target = args.find((a) => !a.startsWith("-") || a === "-");
      if (target === undefined) here = home;
      else if (target === "-") here = null;
      else {
        const path = expand(target, env, home);
        here = isAbsolute(path) ? resolve(path) : here === null ? null : resolve(here, path);
      }
      continue;
    }
    if (["bash", "sh", "zsh", "dash"].includes(name) && depth < 3) {
      const flag = args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
      if (flag !== -1 && args[flag + 1] !== undefined) {
        const inner = destructiveReason(args[flag + 1], { cwd: here, protectedPaths, env, home, depth: depth + 1 });
        if (inner) return inner;
      }
      continue;
    }
    if (name === "rm") {
      const f = flags(args);
      if (!f.has("--recursive", "r") && !f.short.has("R")) continue;
      const end = args.indexOf("--");
      const targets = args.filter((a, k) => (end !== -1 && k > end) || (!a.startsWith("-") && (end === -1 || k < end)));
      for (const target of targets) {
        let path = expand(target, env, home);
        const glob = path.search(/[*?[]/);
        if (glob !== -1) path = path.slice(0, path.lastIndexOf("/", glob) + 1) || ".";
        if (!isAbsolute(path)) { if (here === null) continue; path = resolve(here, path); } else path = resolve(path);
        const hit = guarded.find((kept) => kept === path || kept.startsWith(path === sep ? sep : path + sep));
        if (hit) return `rm -r of ${target} would delete ${hit === path ? "a protected folder" : "a folder holding " + hit}`;
      }
      continue;
    }
    if (name !== "git") continue;
    let k = 0;
    let gitCwd = here;
    while (k < args.length && args[k].startsWith("-")) {
      if (args[k] === "-C") { const path = expand(args[k + 1] ?? "", env, home); gitCwd = isAbsolute(path) ? path : gitCwd && resolve(gitCwd, path); k += 2; }
      else if (["-c", "--git-dir", "--work-tree", "--namespace"].includes(args[k])) k += 2;
      else k++;
    }
    const sub = args[k];
    const rest = args.slice(k + 1);
    const f = flags(rest);
    const positional = [];
    const end = rest.indexOf("--");
    for (let j = 0; j < rest.length; j++) {
      if (j === end) continue;
      if (end !== -1 && j > end) { positional.push(rest[j]); continue; }
      if (rest[j].startsWith("-")) { if (["-o", "--push-option", "--repo", "--receive-pack", "--exec"].includes(rest[j])) j++; continue; }
      positional.push(rest[j]);
    }
    if (sub === "push") {
      const refspecs = positional.slice(1);
      const force = f.has("--force", "f") || f.long.has("--force-with-lease") || refspecs.some((r) => r.startsWith("+"));
      if (!force) continue;
      if (f.long.has("--all") || f.long.has("--mirror") || f.long.has("--branches")) return "git push --force of every branch would overwrite main";
      const current = gitCwd ? git(gitCwd, ["symbolic-ref", "--short", "-q", "HEAD"]) : null;
      const targets = refspecs.length ? refspecs.map((r) => { const s = r.replace(/^\+/, ""); const dst = s.includes(":") ? s.slice(s.indexOf(":") + 1) : s; return dst === "HEAD" ? current ?? "" : dst; }) : [current ?? ""];
      if (targets.some((t) => PROTECTED_BRANCH.test(t))) return "git push --force to main or master would overwrite shared history";
      continue;
    }
    if (sub === "reset" && f.long.has("--hard")) return "git reset --hard discards uncommitted changes";
    if (sub === "clean" && f.has("--force", "f") && !f.has("--dry-run", "n") && (f.short.has("d") || f.short.has("x") || f.short.has("X"))) return "git clean -f with -d or -x deletes untracked and ignored files for good";
    if (sub === "branch" && (f.short.has("D") || ((f.has("--delete", "d")) && f.has("--force", "f")))) return "git branch -D deletes a branch even when its commits are not merged";
    if ((sub === "checkout" || sub === "restore") && positional.some((p) => BROAD.has(p))) {
      if (sub === "restore" && (f.has("--staged", "S")) && !f.has("--worktree", "W")) continue;
      const status = gitCwd ? git(gitCwd, ["status", "--porcelain", "--untracked-files=no"]) : null;
      if (status) return `git ${sub} . throws away every uncommitted change in this tree`;
    }
  }
  return null;
}
